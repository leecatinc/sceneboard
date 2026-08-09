import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3430';
const RUNTIME_ORIGIN = 'http://127.0.0.2:3431';
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
const makePackage = () => {
  const resources = [
    {
      path: 'index.html',
      mediaType: 'text/html',
      bytes: Buffer.from(
        '<main id="production-artifact" style="width:1200px;height:675px">production artifact</main>',
      ),
    },
    {
      path: 'main.js',
      mediaType: 'application/javascript',
      bytes: Buffer.from(
        "globalThis.__productionAuthoredScript = true; globalThis.__productionTrustedWheels = 0; window.addEventListener('wheel', (event) => { if (event.isTrusted) globalThis.__productionTrustedWheels += 1; }); window.SceneBoardArtifact.requestResize(1600, 900);",
      ),
    },
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
    requestedCapabilities: [],
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
const bridgeBuildResult = await build({
  entryPoints: [new URL('./fixtures/artifact-bridge-entry.tsx', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
});
const bridgeFixtureSource = new TextDecoder().decode(bridgeBuildResult.outputFiles[0].contents);
const fixtureConfig = JSON.stringify({
  runtimeOrigin: RUNTIME_ORIGIN,
  packageBase64: artifactPackage.bytes.toString('base64'),
  manifest: artifactPackage.manifest,
}).replaceAll('<', '\\u003c');
const document = `<!doctype html><html><head><style>
html,body,#root{width:100%;height:100%;margin:0}.artifact-host,.artifact-frame-container{width:800px;height:600px}
.artifact-frame-container{position:relative;overflow:hidden}.artifact-runtime-stage{position:relative;overflow:hidden;width:100%;height:100%}
.artifact-runtime-transform{position:absolute;width:1200px;height:675px;transform-origin:0 0}.artifact-runtime-frame{display:block;width:1200px;height:675px;border:0}
</style></head><body><div id="root"></div><script>
window.__artifactFixture = ${fixtureConfig};
window.__resourceProbe = { rafScheduled: 0, rafExecuted: 0, rafCancelled: 0, observers: 0, observed: 0, disconnected: 0, intervals: 0, intervalsCleared: 0, events: [], held: new Map(), nextHeldId: 1000000 };
window.__holdFrames = false;
const nativeRaf = window.requestAnimationFrame.bind(window); const nativeCancel = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) => { window.__resourceProbe.rafScheduled += 1; if (window.__holdFrames) { const id = window.__resourceProbe.nextHeldId++; window.__resourceProbe.held.set(id, callback); return id; } return nativeRaf((time) => { window.__resourceProbe.rafExecuted += 1; callback(time); }); };
window.cancelAnimationFrame = (id) => { window.__resourceProbe.rafCancelled += 1; if (window.__resourceProbe.held.delete(id)) return; nativeCancel(id); };
const nativeSetInterval = window.setInterval.bind(window); const nativeClearInterval = window.clearInterval.bind(window);
window.setInterval = (...args) => { window.__resourceProbe.intervals += 1; return nativeSetInterval(...args); };
window.clearInterval = (id) => { window.__resourceProbe.intervalsCleared += 1; window.__resourceProbe.events.push('clear-interval'); return nativeClearInterval(id); };
const nativePortPost = MessagePort.prototype.postMessage; const nativePortClose = MessagePort.prototype.close; const nativeRemove = Element.prototype.remove;
MessagePort.prototype.postMessage = function(value, transfer) { if (value?.message?.type === 'host.dispose') window.__resourceProbe.events.push('host.dispose'); return Reflect.apply(nativePortPost, this, transfer === undefined ? [value] : [value, transfer]); };
MessagePort.prototype.close = function() { window.__resourceProbe.events.push('port.close'); return Reflect.apply(nativePortClose, this, []); };
Element.prototype.remove = function() { if (this.classList?.contains('artifact-runtime-frame')) window.__resourceProbe.events.push('frame.remove'); return Reflect.apply(nativeRemove, this, []); };
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class { constructor(callback) { this.inner = new NativeResizeObserver(callback); window.__resourceProbe.observers += 1; } observe(target) { window.__resourceProbe.observed += 1; this.inner.observe(target); } unobserve(target) { this.inner.unobserve(target); } disconnect() { window.__resourceProbe.disconnected += 1; this.inner.disconnect(); } };
</script><script src="/fixture.js"></script></body></html>`;

const contentType = (path) =>
  extname(path) === '.js'
    ? 'application/javascript'
    : extname(path) === '.json'
      ? 'application/json'
      : 'text/html';
const parseTransform = (value) => {
  const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0(?:px)?\)\s*scale\(([-\d.]+)\)/u.exec(
    value ?? '',
  );
  assert.ok(match, `unexpected transform: ${String(value)}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
};

test(
  'production ArtifactHost owns runtime, registry, controls, transitions, and terminal cleanup',
  { timeout: 30_000 },
  async (context) => {
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const browserContext = await browser.newContext();
    await browserContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === APP_ORIGIN && url.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body: document });
      if (url.origin === APP_ORIGIN && url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'application/javascript', body: fixtureSource });
      if (url.origin === APP_ORIGIN && url.pathname === '/bridge-fixture.js')
        return route.fulfill({ contentType: 'application/javascript', body: bridgeFixtureSource });
      if (url.origin === RUNTIME_ORIGIN) {
        const relative =
          url.pathname === '/runner' ? 'runner.html' : url.pathname.replace(/^\//u, '');
        const body = readFileSync(join(runtimePublic, relative));
        return route.fulfill({ contentType: contentType(relative), body });
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
    const innerFrame = page.frames().find((frame) => frame.url().startsWith('blob:'));
    assert.ok(innerFrame);
    await innerFrame.waitForFunction(() => globalThis.__productionAuthoredScript === true);
    await page.waitForFunction(() =>
      window.__artifactHostHarness
        .snapshot()
        .resizeEvents.some((event) => event.width === 1_600 && event.height === 900),
    );
    await page.evaluate(() => {
      window.__initialArtifactFrame = document.querySelector('.artifact-runtime-frame');
    });

    const initial = await page.evaluate(() => window.__artifactHostHarness.snapshot());
    assert.equal(initial.phase, 'artifact-host artifact-active');
    assert.equal(initial.mode, 'actual');
    assert.equal(initial.children, 1);
    assert.equal(initial.frameTitle, 'SceneBoard isolated artifact');
    for (const label of ['Fill area', 'Fit page', 'Fit width', 'Actual size'])
      assert.match(initial.controls, new RegExp(label, 'u'));
    assert.equal(initial.viewEvents[0].phase, 'register');
    assert.ok(
      initial.resizeEvents.some(
        (event) => event.width === 1_600 && event.height === 900 && event.source === 'explicit',
      ),
    );

    const box = await innerFrame.locator('body').boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(
      () => window.__artifactHostHarness.snapshot().navigationEvents.length === 1,
    );
    const zoomed = await page.evaluate(() => window.__artifactHostHarness.snapshot());
    assert.notEqual(zoomed.zoom, '100');
    assert.match(zoomed.transform, /scale\(1\./u);
    assert.ok(zoomed.viewEvents.some((event) => event.phase === 'interaction'));
    assert.deepEqual(zoomed.navigationEvents, [
      {
        version: 0,
        intent: {
          type: 'artifact.navigation.wheel',
          xMillionth: 500_000,
          yMillionth: 500_000,
          deltaY: -120,
        },
      },
    ]);

    const beforePan = parseTransform(zoomed.transform);
    const panBox = await innerFrame.locator('body').boundingBox();
    assert.ok(panBox);
    await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(panBox.x + panBox.width / 2 + 40, panBox.y + panBox.height / 2 + 25, {
      steps: 1,
    });
    await page.mouse.up({ button: 'middle' });
    await page.waitForFunction(
      () =>
        window.__artifactHostHarness
          .snapshot()
          .navigationEvents.some((event) => event.intent.type === 'artifact.navigation.pan.end'),
      undefined,
      { timeout: 5_000 },
    );
    const afterPan = await page.evaluate(() => window.__artifactHostHarness.snapshot());
    const panned = parseTransform(afterPan.transform);
    assert.ok(Math.abs(panned.x - beforePan.x - 40) < 0.01);
    assert.ok(Math.abs(panned.y - beforePan.y - 25) < 0.01);
    assert.equal(afterPan.panning, null);

    await page.evaluate(() => {
      const container = document.querySelector('.artifact-frame-container');
      container.scrollLeft = 73;
      container.scrollTop = 41;
      window.__artifactHostHarness.mode('fit-width');
    });
    const fitted = await page.evaluate(() => window.__artifactHostHarness.snapshot());
    assert.equal(fitted.mode, 'fit-width');
    assert.equal(fitted.scrollLeft, 0);
    assert.equal(fitted.scrollTop, 0);
    assert.ok(fitted.viewEvents.some((event) => event.phase === 'unregister'));
    assert.equal(
      await page.evaluate(
        () => document.querySelector('.artifact-runtime-frame') === window.__initialArtifactFrame,
      ),
      true,
    );
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(75);
    assert.equal(
      (await page.evaluate(() => window.__artifactHostHarness.snapshot())).navigationEvents.filter(
        (event) => event.intent.type === 'artifact.navigation.wheel',
      ).length,
      1,
    );

    await page.evaluate(() => {
      window.__artifactHostHarness.callbackVersion(1);
      window.__artifactHostHarness.mode('actual');
    });
    const actualAgain = await page.evaluate(() => window.__artifactHostHarness.snapshot());
    assert.equal(actualAgain.mode, 'actual');
    assert.equal(actualAgain.zoom, '100');
    assert.equal(
      await page.evaluate(
        () => document.querySelector('.artifact-runtime-frame') === window.__initialArtifactFrame,
      ),
      true,
    );
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(
      () =>
        window.__artifactHostHarness
          .snapshot()
          .navigationEvents.filter((event) => event.intent.type === 'artifact.navigation.wheel')
          .length === 2,
    );
    assert.equal(
      (await page.evaluate(() => window.__artifactHostHarness.snapshot())).navigationEvents
        .filter((event) => event.intent.type === 'artifact.navigation.wheel')
        .at(-1).version,
      1,
    );
    const centeredTransform = actualAgain.transform;
    await page.evaluate(() => {
      window.__artifactHostHarness.mode('fit-height');
      window.__artifactHostHarness.mode('actual');
    });
    assert.equal(
      (await page.evaluate(() => window.__artifactHostHarness.snapshot())).transform,
      centeredTransform,
    );

    const beforeResize = await page.evaluate(() => {
      window.__holdFrames = true;
      return { ...window.__resourceProbe, held: window.__resourceProbe.held.size };
    });
    const resizeCountBeforeLatest = await page.evaluate(
      () => window.__artifactHostHarness.snapshot().resizeEvents.length,
    );
    await innerFrame.evaluate(() => window.SceneBoardArtifact.requestResize(1_600, 900));
    await page.waitForFunction(
      (count) => window.__artifactHostHarness.snapshot().resizeEvents.length === count + 1,
      resizeCountBeforeLatest,
    );
    assert.deepEqual(
      await page.evaluate(() => window.__artifactHostHarness.snapshot().resizeEvents.at(-1)),
      {
        version: 1,
        width: 1_600,
        height: 900,
        source: 'explicit',
      },
    );
    await page.waitForFunction(
      (count) => window.__resourceProbe.rafScheduled > count,
      beforeResize.rafScheduled,
    );
    const queued = await page.evaluate(() => ({
      ...window.__resourceProbe,
      held: window.__resourceProbe.held.size,
    }));
    assert.equal(queued.held, 1);
    await page.evaluate(() => window.__artifactHostHarness.stop());
    await page.waitForFunction(() =>
      document.querySelector('.artifact-host')?.classList.contains('artifact-stopped'),
    );
    await page.waitForTimeout(75);
    const terminal = await page.evaluate(() => ({
      snapshot: window.__artifactHostHarness.snapshot(),
      resources: { ...window.__resourceProbe, held: window.__resourceProbe.held.size },
    }));
    assert.equal(terminal.snapshot.phase, 'artifact-host artifact-stopped');
    assert.equal(terminal.snapshot.children, 0);
    assert.equal(terminal.snapshot.mode, null);
    assert.equal(terminal.snapshot.zoom, null);
    assert.equal(terminal.snapshot.stageWidth, null);
    assert.ok(
      terminal.snapshot.resizeEvents.some((event) => event.width === 1_600 && event.height === 900),
    );
    assert.ok(terminal.resources.rafCancelled > queued.rafCancelled);
    assert.equal(terminal.resources.rafExecuted, queued.rafExecuted);
    assert.equal(terminal.resources.held, 0);
    assert.ok(terminal.resources.disconnected >= 1);
    assert.ok(terminal.resources.intervalsCleared >= 1);
    assert.ok(terminal.resources.events.indexOf('host.dispose') >= 0);
    assert.ok(
      terminal.resources.events.indexOf('host.dispose') <
        terminal.resources.events.indexOf('port.close'),
    );
    assert.ok(
      terminal.resources.events.indexOf('port.close') <
        terminal.resources.events.indexOf('frame.remove'),
    );
    assert.equal(terminal.snapshot.viewEvents.at(-1).phase, 'unregister');

    const beforeUnmount = terminal.resources.disconnected;
    await page.evaluate(() => window.__artifactHostHarness.unmount());
    assert.equal(await page.locator('#root').innerHTML(), '');
    assert.ok((await page.evaluate(() => window.__resourceProbe.disconnected)) >= beforeUnmount);
    assert.equal(page.frames().filter((frame) => frame !== page.mainFrame()).length, 0);
  },
);

test(
  'active ArtifactHost unmount unregisters and disposes its runtime',
  { timeout: 30_000 },
  async (context) => {
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const browserContext = await browser.newContext();
    await browserContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === APP_ORIGIN && url.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body: document });
      if (url.origin === APP_ORIGIN && url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'application/javascript', body: fixtureSource });
      if (url.origin === RUNTIME_ORIGIN) {
        const relative =
          url.pathname === '/runner' ? 'runner.html' : url.pathname.replace(/^\//u, '');
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
    const before = await page.evaluate(() => ({
      snapshot: window.__artifactHostHarness.snapshot(),
      events: [...window.__resourceProbe.events],
    }));
    assert.equal(before.snapshot.viewEvents.at(-1).phase, 'register');
    await page.evaluate(() => window.__artifactHostHarness.unmount());
    await page.waitForFunction(() => document.querySelector('.artifact-host') === null);
    const after = await page.evaluate(() => ({
      snapshot: window.__artifactHostHarness.snapshot(),
      events: [...window.__resourceProbe.events],
      disconnected: window.__resourceProbe.disconnected,
    }));
    assert.equal(after.snapshot.viewEvents.at(-1).phase, 'unregister');
    assert.ok(after.events.includes('host.dispose'));
    assert.ok(after.events.includes('port.close'));
    assert.ok(after.events.includes('frame.remove'));
    assert.ok(after.disconnected >= 1);
    assert.equal(page.frames().filter((frame) => frame !== page.mainFrame()).length, 0);
  },
);

test(
  'production bridge batches its activation seed and keeps later resize callback-only',
  { timeout: 30_000 },
  async (context) => {
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const browserContext = await browser.newContext();
    const bridgeDocument = document.replace('/fixture.js', '/bridge-fixture.js');
    await browserContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === APP_ORIGIN && url.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body: bridgeDocument });
      if (url.origin === APP_ORIGIN && url.pathname === '/bridge-fixture.js')
        return route.fulfill({ contentType: 'application/javascript', body: bridgeFixtureSource });
      if (url.origin === RUNTIME_ORIGIN) {
        const relative =
          url.pathname === '/runner' ? 'runner.html' : url.pathname.replace(/^\//u, '');
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
      () => window.__artifactBridgeHarness?.snapshot().phase === 'active',
      undefined,
      { timeout: 10_000 },
    );
    const active = await page.evaluate(() => window.__artifactBridgeHarness.snapshot());
    assert.deepEqual(active.contentSize, { width: 1_200, height: 675 });
    assert.ok(
      active.timeline.some(
        (entry) =>
          entry.phase === 'active' &&
          entry.contentSize?.width === 1_200 &&
          entry.contentSize?.height === 675,
      ),
    );
    assert.ok(
      active.resizeEvents.some(
        (entry) => entry.phase !== 'active' && entry.value.source === 'explicit',
      ),
    );
    const renderCount = active.renderCount;
    await page.evaluate(() => {
      window.__artifactBridgeHarness.rememberFrame();
      window.__artifactBridgeHarness.callbackVersion(1);
      window.__artifactBridgeHarness.viewMode('fit-height');
      window.__artifactBridgeHarness.viewMode('actual');
    });
    await page.waitForFunction(
      (priorRenderCount) =>
        window.__artifactBridgeHarness.snapshot().renderCount > priorRenderCount,
      renderCount,
      { timeout: 5_000 },
    );
    assert.equal(await page.evaluate(() => window.__artifactBridgeHarness.frameStable()), true);
    await page.waitForTimeout(100);
    const innerFrame = page.frames().find((frame) => frame.url().startsWith('blob:'));
    assert.ok(innerFrame);
    await innerFrame.evaluate(() => window.SceneBoardArtifact.requestResize(1_700, 950));
    await page.waitForFunction(() =>
      window.__artifactBridgeHarness
        .snapshot()
        .resizeEvents.some((entry) => entry.value.width === 1_700),
    );
    const frameBox = await innerFrame.locator('body').boundingBox();
    assert.ok(frameBox);
    await innerFrame.locator('body').hover({ position: { x: 100, y: 100 } });
    await page.mouse.wheel(0, -120);
    await innerFrame.waitForFunction(() => globalThis.__productionTrustedWheels === 1, undefined, {
      timeout: 5_000,
    });
    await page.waitForFunction(
      () => window.__artifactBridgeHarness.snapshot().navigationEvents.length === 1,
      undefined,
      { timeout: 5_000 },
    );
    const afterResize = await page.evaluate(() => window.__artifactBridgeHarness.snapshot());
    assert.ok(afterResize.renderCount > renderCount);
    assert.equal(afterResize.resizeEvents.find((entry) => entry.value.width === 1_700).version, 1);
    assert.deepEqual(
      afterResize.navigationEvents.map((entry) => entry.version),
      [1],
    );
    assert.equal(await page.evaluate(() => window.__artifactBridgeHarness.frameStable()), true);
    assert.deepEqual(afterResize.contentSize, { width: 1_200, height: 675 });
    await page.evaluate(() => window.__artifactBridgeHarness.stop());
    await page.waitForFunction(() => window.__artifactBridgeHarness.snapshot().phase === 'stopped');
    assert.deepEqual(
      (await page.evaluate(() => window.__artifactBridgeHarness.snapshot())).contentSize,
      null,
    );
  },
);
