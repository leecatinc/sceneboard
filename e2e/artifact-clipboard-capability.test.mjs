import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3460';
const RUNTIME_ORIGIN = 'http://127.0.0.2:3461';
const runtimePublic = new URL('../packages/artifact-runtime/dist/public/', import.meta.url)
  .pathname;
const artifact = { artifactId: 'artifact_one', versionId: 'version_one' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const uint16 = (value) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};
const uint32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

const authoredScript = String.raw`
const ids = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC', 'DDDDDDDDDDDDDDDDDDDDDD'];
let index = 0;
const status = document.querySelector('#status');
document.addEventListener('click', (event) => { status.dataset.trusted = String(event.isTrusted); }, true);
const copy = (text) => {
  const requestId = ids[index++];
  SceneBoardArtifact.userAction(requestId, 'clipboard.write');
  SceneBoardArtifact.requestCapability(requestId, 'clipboard.write', { text });
};
SceneBoardArtifact.onHostMessage((message) => {
  if (message.type !== 'host.capability.result') return;
  status.dataset.ok = String(message.ok);
  status.dataset.error = message.ok ? '' : message.error;
  status.dataset.bytes = message.ok ? String(message.result.byteLength) : '';
  status.dataset.count = String(Number(status.dataset.count || '0') + 1);
});
document.querySelector('#copy').addEventListener('click', () => copy('trusted-pointer'));
document.querySelector('#keyboard').addEventListener('click', () => copy('trusted-keyboard'));
document.querySelector('#epoch').addEventListener('click', () => {
  const requestId = ids[index++];
  SceneBoardArtifact.userAction(requestId, 'clipboard.write');
  SceneBoardArtifact.requestResize(777, 333);
  window.__sendStaleEpochRequest = () =>
    SceneBoardArtifact.requestCapability(requestId, 'clipboard.write', { text: 'stale-epoch' });
});
setTimeout(() => copy('scripted-no-input'), 6_000);
`;

const makePackage = () => {
  const resources = [
    {
      path: 'index.html',
      mediaType: 'text/html',
      bytes: Buffer.from(
        '<main><button id="copy">Copy pointer</button><button id="keyboard">Copy keyboard</button><button id="epoch">Copy stale epoch</button><textarea readonly>selectable fallback</textarea><output id="status" data-count="0"></output></main>',
      ),
    },
    { path: 'main.js', mediaType: 'application/javascript', bytes: Buffer.from(authoredScript) },
  ].map((resource) => ({
    ...resource,
    sha256: sha256(resource.bytes),
    byteLength: resource.bytes.byteLength,
  }));
  const manifest = {
    protocolVersion: 1,
    type: 'artifact.manifest',
    artifact,
    entryPath: 'index.html',
    resources: resources.map(({ path, mediaType, sha256: digest, byteLength }) => ({
      path,
      mediaType,
      sha256: digest,
      byteLength,
    })),
    requestedCapabilities: ['clipboard.write'],
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const parts = [
    Buffer.from([76, 67, 65, 82, 84, 86, 49, 0]),
    uint32(manifestBytes.byteLength),
    manifestBytes,
    uint16(resources.length),
  ];
  for (const resource of resources) {
    const path = Buffer.from(resource.path);
    parts.push(uint16(path.byteLength), path, uint32(resource.byteLength), resource.bytes);
  }
  return { bytes: Buffer.concat(parts), manifest };
};

const artifactPackage = makePackage();
const buildResult = await build({
  entryPoints: [new URL('./fixtures/artifact-host-entry.tsx', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
});
const fixtureSource = new TextDecoder().decode(buildResult.outputFiles[0].contents);
const fixtureConfig = JSON.stringify({
  runtimeOrigin: RUNTIME_ORIGIN,
  packageBase64: artifactPackage.bytes.toString('base64'),
  manifest: artifactPackage.manifest,
  allowedArtifactRequestCapabilities: ['clipboard.write'],
  artifactCapabilityEpoch: 1,
}).replaceAll('<', '\\u003c');
const document = `<!doctype html><html><head><style>
html,body,#root{width:100%;height:100%;margin:0}.artifact-host,.artifact-frame-container{width:1200px;height:675px}
.artifact-frame-container{position:relative;overflow:hidden}.artifact-runtime-stage{position:relative;width:100%;height:100%}
.artifact-runtime-transform{position:absolute;width:1200px;height:675px}.artifact-runtime-frame{display:block;width:1200px;height:675px;border:0}
</style></head><body><div id="root"></div><script>window.__artifactFixture=${fixtureConfig}</script><script src="/fixture.js"></script></body></html>`;
const contentType = (path) => (extname(path) === '.js' ? 'application/javascript' : 'text/html');

test(
  'isolated artifact clipboard requires real pointer or keyboard activation',
  { timeout: 45_000 },
  async (context) => {
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const browserContext = await browser.newContext({ viewport: { width: 1_920, height: 1_080 } });
    await browserContext.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: APP_ORIGIN,
    });
    await browserContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === APP_ORIGIN && url.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body: document });
      if (url.origin === APP_ORIGIN && url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'application/javascript', body: fixtureSource });
      if (url.origin === RUNTIME_ORIGIN) {
        const relative = url.pathname === '/runner' ? 'runner.html' : url.pathname.slice(1);
        return route.fulfill({
          contentType: contentType(relative),
          body: readFileSync(join(runtimePublic, relative)),
        });
      }
      return route.abort('blockedbyclient');
    });
    const page = await browserContext.newPage();
    await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.querySelector('.artifact-host')?.classList.contains('artifact-active'),
      undefined,
      { timeout: 10_000 },
    );
    const inner = page.frames().find((frame) => frame.url().startsWith('blob:'));
    assert.ok(inner);
    await inner.waitForFunction(
      () => document.querySelector('#status')?.dataset.count === '1',
      undefined,
      {
        timeout: 8_000,
      },
    );
    assert.deepEqual(
      await inner.locator('#status').evaluate((element) => ({
        ok: element.dataset.ok,
        error: element.dataset.error,
      })),
      { ok: 'false', error: 'activation_required' },
    );
    const pointerBox = await inner.locator('#copy').boundingBox();
    assert.ok(pointerBox);
    await page.mouse.click(
      pointerBox.x + pointerBox.width / 2,
      pointerBox.y + pointerBox.height / 2,
    );
    await page.waitForTimeout(300);
    assert.equal(
      await inner.locator('#status').getAttribute('data-count'),
      '2',
      `trusted click missed ${JSON.stringify(pointerBox)}`,
    );
    assert.equal(
      await inner.locator('#status').getAttribute('data-ok'),
      'true',
      `pointer copy error: ${await inner.locator('#status').getAttribute('data-error')}; trusted=${await inner.locator('#status').getAttribute('data-trusted')}`,
    );
    assert.equal(
      await page.evaluate(() =>
        Promise.race([
          navigator.clipboard.readText(),
          new Promise((resolve) => setTimeout(() => resolve('read-timeout'), 2_000)),
        ]),
      ),
      'trusted-pointer',
    );

    await inner.locator('#keyboard').evaluate((element) => element.focus());
    await page.keyboard.press('Enter');
    await inner.waitForFunction(
      () => document.querySelector('#status')?.dataset.count === '3',
      undefined,
      {
        timeout: 5_000,
      },
    );
    assert.equal(await inner.locator('#status').getAttribute('data-ok'), 'true');
    assert.equal(
      await page.evaluate(() =>
        Promise.race([
          navigator.clipboard.readText(),
          new Promise((resolve) => setTimeout(() => resolve('read-timeout'), 2_000)),
        ]),
      ),
      'trusted-keyboard',
    );

    await inner.locator('#epoch').click();
    await page.waitForFunction(() =>
      window.__artifactHostHarness
        ?.snapshot()
        .resizeEvents.some((event) => event.width === 777 && event.height === 333),
    );
    await page.evaluate(() => window.__artifactHostHarness?.capabilityEpoch(2));
    await inner.evaluate(() => window.__sendStaleEpochRequest());
    await inner.waitForFunction(
      () => document.querySelector('#status')?.dataset.count === '4',
      undefined,
      { timeout: 5_000 },
    );
    assert.deepEqual(
      await inner.locator('#status').evaluate((element) => ({
        ok: element.dataset.ok,
        error: element.dataset.error,
      })),
      { ok: 'false', error: 'revoked' },
    );
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'trusted-keyboard');
  },
);
