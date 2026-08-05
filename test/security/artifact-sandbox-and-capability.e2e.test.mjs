import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

import { registerAuthenticatedBoundaryRows } from './security-catalog.test-helper.mjs';

const { decideArtifactCapabilityV1 } = await tsImport(
  '../../packages/artifact-runtime/src/policy/capabilities.ts',
  import.meta.url,
);
const { buildRunnerContentSecurityPolicyV1 } = await tsImport(
  '../../packages/artifact-runtime/src/policy/csp.ts',
  import.meta.url,
);
const { ArtifactRateBudgetV1 } = await tsImport(
  '../../packages/artifact-runtime/src/bridge/rate-budget.ts',
  import.meta.url,
);
const { buildFixedAssetHeadersV1, buildRunnerHeadersV1, assertRuntimeHeadersV1 } = await tsImport(
  '../../packages/artifact-runtime/src/server/headers.ts',
  import.meta.url,
);
const { INNER_SANDBOX_TOKENS_V1, OUTER_SANDBOX_TOKENS_V1 } = await tsImport(
  '../../packages/artifact-runtime/src/policy/csp.ts',
  import.meta.url,
);
const limits = await tsImport('../../packages/board-schema/src/limits.ts', import.meta.url);
const boardSchema = await tsImport('../../packages/board-schema/src/index.ts', import.meta.url);
const quotaLimits = {
  maxBoardArtifacts: limits.MAX_BOARD_ARTIFACTS,
  maxBoardArtifactVersions: limits.MAX_BOARD_ARTIFACT_VERSIONS,
  maxBoardArtifactResourceRows: limits.MAX_BOARD_ARTIFACT_RESOURCE_ROWS,
  maxBoardArtifactChargedBytes: limits.MAX_BOARD_ARTIFACT_CHARGED_BYTES,
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chromiumExecutable =
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
let browserRuntimeGap = null;
try {
  await access(chromiumExecutable);
} catch {
  browserRuntimeGap = 'the locked Chromium executable is unavailable in this workspace';
}

const listen = async (server) => {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('browser server unavailable');
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = (server) =>
  new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asBytes = (value) => new TextEncoder().encode(value);

const artifactPackage = (probe, appOrigin, trusted = false) => {
  const artifact = {
    artifactId: trusted ? 'artifact_fallback' : 'artifact_hostile',
    versionId: trusted ? 'version_fallback' : `version_${probe.toLowerCase().replaceAll('-', '_')}`,
  };
  const report = (expression) =>
    `(()=>{const denied=(${expression});SceneBoardArtifact.changePresentationPage({pageId:denied?'denied':'escaped',pageIndex:0,pageCount:1});console.log('SCENEBOARD_HOSTILE:${probe}:'+(denied?'DENIED':'ESCAPED'));})()`;
  const source = trusted
    ? `SceneBoardArtifact.changePresentationPage({pageId:'ready',pageIndex:0,pageCount:1});console.log('SCENEBOARD_TRUSTED_FALLBACK:READY');`
    : {
        'RUNNER-ZERO-COOKIE': `try { ${report(`document.cookie === ''`)} } catch { ${report('true')} }`,
        'ASSET-ZERO-COOKIE': `try { ${report(`document.cookie === ''`)} } catch { ${report('true')} }`,
        'OPAQUE-ORIGIN': report(`location.origin === 'null'`),
        'NO-PARENT-DOM': `try { void parent.document.body; ${report('false')} } catch { ${report('true')} }`,
        'NO-STORAGE': `try { localStorage.setItem('escape', '1'); ${report('false')} } catch { ${report('true')} }`,
        'NO-TOP-NAVIGATION': `try { top.location.href = 'https://example.invalid/escape'; setTimeout(()=>{${report('true')}},50) } catch { ${report('true')} }`,
        'CSP-SCRIPT': `const script=document.createElement('script');script.src='${appOrigin}/forbidden.js';script.onload=()=>{${report('false')}};script.onerror=()=>{${report('true')}};document.body.append(script);`,
        'CSP-CONNECT': `fetch('${appOrigin}/forbidden-connect').then(()=>{${report('false')}}).catch(()=>{${report('true')}});`,
        'BRIDGE-REPLAY': `window.postMessage({protocolVersion:1,type:'artifact.bridge',sequence:1},'*');queueMicrotask(()=>{try{SceneBoardArtifact.requestResize(1200,675);${report('true')}}catch{${report('false')}}});`,
        'BRIDGE-SOURCE-ORIGIN': `window.dispatchEvent(new MessageEvent('message',{data:{protocolVersion:1,type:'artifact.bridge'},origin:'https://example.invalid'}));queueMicrotask(()=>{try{SceneBoardArtifact.requestResize(1200,675);${report('true')}}catch{${report('false')}}});`,
        'HOSTILE-INFINITE-LOOP': `for (;;) {}`,
        'TRUSTED-FALLBACK': `for (;;) {}`,
      }[probe];
  if (source === undefined) throw new Error(`unsupported hostile browser probe: ${probe}`);
  const resources = [
    { path: 'index.html', mediaType: 'text/html', bytes: asBytes('<main>hostile fixture</main>') },
    { path: 'main.js', mediaType: 'text/javascript', bytes: asBytes(source) },
  ];
  const parsed = boardSchema.ArtifactManifestParserV1.parse({
    protocolVersion: 1,
    type: 'artifact.manifest',
    artifact,
    entryPath: 'index.html',
    resources: resources.map(({ path, mediaType, bytes }) => ({
      path,
      mediaType,
      sha256: digest(bytes),
      byteLength: bytes.byteLength,
    })),
    requestedCapabilities: probe === 'CSP-CONNECT' ? ['network.fetch'] : [],
  });
  if (!parsed.ok) throw new Error('hostile artifact manifest is invalid');
  const manifestBytes = parsed.data.canonicalBytes;
  const total = resources.reduce(
    (size, resource) =>
      size + 2 + asBytes(resource.path).byteLength + 4 + resource.bytes.byteLength,
    8 + 4 + manifestBytes.byteLength + 2,
  );
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(asBytes('LCARTV1\0'));
  let offset = 8;
  view.setUint32(offset, manifestBytes.byteLength, false);
  offset += 4;
  bytes.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;
  view.setUint16(offset, resources.length, false);
  offset += 2;
  for (const resource of resources) {
    const path = asBytes(resource.path);
    view.setUint16(offset, path.byteLength, false);
    offset += 2;
    bytes.set(path, offset);
    offset += path.byteLength;
    view.setUint32(offset, resource.bytes.byteLength, false);
    offset += 4;
    bytes.set(resource.bytes, offset);
    offset += resource.bytes.byteLength;
  }
  return {
    probe,
    artifact,
    manifest: parsed.data.value,
    packageBase64: Buffer.from(bytes).toString('base64'),
  };
};

const hostBundle = async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ArtifactHost } from './packages/board-ui/src/artifact/ArtifactHost.tsx';
        const root = createRoot(document.getElementById('root'));
        let epoch = 0;
        window.__artifactBridgeObservations = [];
        window.__mountArtifact = (fixture) => {
          epoch += 1;
          window.__activeProbe = fixture.probe;
          const runtime = { artifact: fixture.artifact, status: 'ready', updatedAt: '2026-08-03T00:00:00.000Z', failure: null };
          const load = {
            readMetadata: async () => ({ manifest: fixture.manifest, runtime }),
            readPackage: async () => Uint8Array.from(atob(fixture.packageBase64), (value) => value.charCodeAt(0)),
          };
          root.render(React.createElement(ArtifactHost, {
            key: epoch,
            boardId: 'board_1', artifact: fixture.artifact, runtime,
            runtimeOrigin: window.__runtimeOrigin, routeEpoch: 'route_' + epoch,
            snapshotWatermark: epoch, load, hostInstanceId: 'artifact_host',
            incarnationKey: 'route_' + epoch + ':artifact_host:' + fixture.artifact.artifactId + ':' + fixture.artifact.versionId,
            onPresentationPageChange: (event) => {
              const marker = window.__activeProbe === 'TRUSTED-FALLBACK'
                ? 'SCENEBOARD_TRUSTED_FALLBACK:' + event.pageId.toUpperCase()
                : 'SCENEBOARD_HOSTILE:' + window.__activeProbe + ':' + event.pageId.toUpperCase();
              window.__artifactBridgeObservations.push(marker);
              console.log(marker);
            },
          }));
        };
        window.__mountArtifact(window.__hostileFixture);
      `,
      resolveDir: repositoryRoot,
      sourcefile: 'security-artifact-host.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
  });
  const output = result.outputFiles?.[0]?.contents;
  if (output === undefined) throw new Error('ArtifactHost browser bundle was not emitted');
  return output;
};

const waitForBridgeObservation = async (page, marker, timeoutMs = 5_000) => {
  try {
    await page.waitForFunction(
      (expected) => window.__artifactBridgeObservations?.includes(expected) === true,
      marker,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const observed = await page.evaluate(() => window.__artifactBridgeObservations ?? []);
    throw new Error(
      `artifact bridge observation missing: ${marker}; observed=${JSON.stringify(observed)}`,
      { cause: error },
    );
  }
};

const exerciseHostAndRunner = async (probe, runtime) => {
  let hostOrigin = '';
  let runtimeOrigin = '';
  let bundle = Buffer.alloc(0);
  let hostileFixture;
  let trustedFixture;
  let forbiddenRequests = 0;
  const appServer = createServer((request, response) => {
    if (request.url === '/host.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    if (request.url === '/forbidden.js' || request.url === '/forbidden-connect') {
      forbiddenRequests += 1;
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end('globalThis.__sandboxEscape=true');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'sceneboard_host_secret=must-not-cross; HttpOnly; SameSite=Lax',
    });
    response.end(
      `<!doctype html><div id="root"></div><script>window.__runtimeOrigin=${JSON.stringify(runtimeOrigin)};window.__hostileFixture=${JSON.stringify(hostileFixture)};window.__trustedFixture=${JSON.stringify(trustedFixture)}</script><script src="/host.js"></script>`,
    );
  });
  const runtimeServer = createServer(async (request, response) => {
    const path = request.url === '/runner' ? 'runner.html' : request.url?.replace(/^\//u, '');
    try {
      const bytes = await readFile(
        join(repositoryRoot, 'packages/artifact-runtime/dist/public', path),
      );
      const headers =
        request.url === '/runner'
          ? buildRunnerHeadersV1({ appOrigin: hostOrigin, runtimeOrigin })
          : buildFixedAssetHeadersV1();
      response.writeHead(200, headers);
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  let browser;
  try {
    hostOrigin = await listen(appServer);
    runtimeOrigin = await listen(runtimeServer);
    hostileFixture = artifactPackage(probe, hostOrigin);
    trustedFixture = artifactPackage('TRUSTED-FALLBACK', hostOrigin, true);
    bundle = Buffer.from(await hostBundle());
    browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
    const page = await browser.newPage();
    const observations = [];
    page.on('console', (message) => observations.push(message.text()));
    page.on('requestfailed', (request) =>
      observations.push(
        `REQUEST_FAILED:${request.url()}:${request.failure()?.errorText ?? 'unknown'}`,
      ),
    );
    await page.goto(hostOrigin);
    const needsFallback = probe === 'HOSTILE-INFINITE-LOOP' || probe === 'TRUSTED-FALLBACK';
    if (needsFallback) {
      await page.locator('.artifact-failed').waitFor({ timeout: 20_000 });
      await page.evaluate(() => window.__mountArtifact(window.__trustedFixture));
      await page.locator('.artifact-active').waitFor({ timeout: 12_000 });
      await waitForBridgeObservation(page, 'SCENEBOARD_TRUSTED_FALLBACK:READY');
      return {
        isolated: forbiddenRequests === 0 && runtime.staticBoundary,
        recovered: observations.includes('SCENEBOARD_TRUSTED_FALLBACK:READY'),
        hostState: 'stopped',
        runnerState: 'stopped',
      };
    }
    try {
      await page.locator('.artifact-active').waitFor({ timeout: 12_000 });
    } catch (error) {
      const hostState = await page
        .locator('.artifact-host')
        .evaluate((element) => ({ className: element.className, text: element.textContent }))
        .catch(() => null);
      throw new Error(
        `artifact host did not become active: ${JSON.stringify({ hostState, observations })}`,
        { cause: error },
      );
    }
    await waitForBridgeObservation(page, `SCENEBOARD_HOSTILE:${probe}:DENIED`);
    return {
      isolated:
        observations.includes(`SCENEBOARD_HOSTILE:${probe}:DENIED`) &&
        forbiddenRequests === 0 &&
        runtime.staticBoundary,
      recovered: false,
      hostState: 'stopped',
      runnerState: 'stopped',
    };
  } finally {
    await browser?.close().catch(() => undefined);
    if (appServer.listening) await closeServer(appServer).catch(() => undefined);
    if (runtimeServer.listening) await closeServer(runtimeServer).catch(() => undefined);
  }
};

const executeHostileBoundary = async (row, fixture) => {
  const runtimeResource = { effects: new Set() };
  const hostResource = { effects: new Set() };
  const runnerResource = { effects: new Set() };
  const registerOwner = (owner, resource) =>
    fixture.registerOwnerResource({
      owner,
      resource,
      cleanup: ({ effects }) => effects.clear(),
      inspectResidue: () => resource.effects.size,
    });
  const runtimeHandle = registerOwner('sceneboard.artifact-runtime', runtimeResource);
  const hostHandle = registerOwner('sceneboard.artifact-host', hostResource);
  const runnerHandle = registerOwner('sceneboard.artifact-runner', runnerResource);
  const runtime = await fixture.operate(
    runtimeHandle,
    'artifact.runtime.configure-hostile-boundary',
    ({ effects }) => {
      const origins = {
        appOrigin: 'http://127.0.0.1:4310',
        runtimeOrigin: 'http://127.0.0.1:4311',
      };
      const csp = buildRunnerContentSecurityPolicyV1(origins);
      const headers = buildRunnerHeadersV1(origins);
      assertRuntimeHeadersV1(headers);
      const staticBoundary =
        OUTER_SANDBOX_TOKENS_V1 === 'allow-scripts' &&
        INNER_SANDBOX_TOKENS_V1 === 'allow-scripts' &&
        csp.includes("connect-src 'none'") &&
        !csp.includes('allow-same-origin') &&
        !Object.keys(headers).some((name) => name.toLowerCase() === 'set-cookie');
      effects.add(`runtime-boundary:${staticBoundary}`);
      return { staticBoundary };
    },
  );
  const observed = await fixture.operate(
    hostHandle,
    'artifact.host.execute-attempt',
    ({ effects: hostEffects }) =>
      fixture.operate(
        runnerHandle,
        'artifact.runner.execute-hostile-package',
        async ({ effects: runnerEffects }) => {
          const result = await exerciseHostAndRunner(row.preconditionState, runtime);
          hostEffects.add(`host-terminal:${result.hostState}`);
          runnerEffects.add(`runner-terminal:${result.runnerState}`);
          return result;
        },
      ),
  );
  return observed.isolated &&
    (row.preconditionState !== 'TRUSTED-FALLBACK' || observed.recovered) &&
    (row.preconditionState !== 'HOSTILE-INFINITE-LOOP' || observed.recovered)
    ? 'ISOLATED_OR_RECOVERED'
    : 'SANDBOX_BOUNDARY_FAILED';
};

const executeArtifactBoundary = (row) =>
  Object.freeze({
    caseId: row.caseId,
    cluster: row.cluster,
    preconditionState: row.preconditionState,
    principalKind: row.principalKind,
  });

const executeArtifactProductionBoundary = async (row, fixture) => {
  if (row.cluster === 'ARTIFACT_HOSTILE') return executeHostileBoundary(row, fixture);
  const effects = new Set();
  const resource = { effects };
  const handle = fixture.registerOwnerResource({
    owner: 'sceneboard.artifact-runtime',
    resource,
    cleanup: ({ effects: ownedEffects }) => ownedEffects.clear(),
    inspectResidue: () => effects.size,
  });
  return fixture.operate(
    handle,
    `artifact.${row.cluster.toLowerCase().replaceAll('_', '-')}`,
    () => {
      if (row.cluster === 'ARTIFACT_QUOTA') {
        const [limitName, boundary] = row.preconditionState.split('-');
        const limit = quotaLimits[limitName];
        if (!Number.isSafeInteger(limit)) throw new Error(`unknown artifact quota: ${limitName}`);
        const attempted = boundary === 'AT_LIMIT' ? limit : limit + 1;
        const budget = new ArtifactRateBudgetV1({
          countRate: 0,
          countBurst: 1,
          byteRate: 0,
          byteBurst: limit,
          now: () => 0,
        });
        const admitted = budget.admit(attempted);
        effects.add(`quota:${limitName}:${admitted}`);
        return admitted ? 'ALLOWED_AT_LIMIT' : 'LIMIT_EXCEEDED';
      }
      if (row.cluster === 'ARTIFACT_POLICY') {
        const separator = row.preconditionState.lastIndexOf('-');
        const capability = row.preconditionState.slice(0, separator);
        const state = row.preconditionState.slice(separator + 1);
        const approved = state.startsWith('APPROVED');
        const decision = decideArtifactCapabilityV1({
          capability,
          manifestRequested: approved ? [capability] : [],
          currentlyAllowed: approved && state !== 'REVOKED' ? [capability] : [],
          policyEpochMatches: state !== 'APPROVED_STALE_EPOCH' && state !== 'REVOKED',
          networkAllowlistConfigured: true,
        });
        effects.add(`capability:${capability}:${decision.ok}`);
        return decision.ok ? 'CAPABILITY_ALLOWED' : 'CAPABILITY_DENIED';
      }
      throw new Error(`unsupported artifact boundary cluster: ${row.cluster}`);
    },
  );
};

await registerAuthenticatedBoundaryRows({
  producerId: 'sceneboard.security.artifact-boundary.v1',
  expectedCounts: { ARTIFACT_QUOTA: 8, ARTIFACT_POLICY: 16, ARTIFACT_HOSTILE: 12 },
  adapter: executeArtifactBoundary,
  executeBoundary: executeArtifactProductionBoundary,
  runtimeGapReason: (row) => (row.cluster === 'ARTIFACT_HOSTILE' ? browserRuntimeGap : null),
});
