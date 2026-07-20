import assert from 'node:assert/strict';
import test from 'node:test';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3440';
const OUTER_ORIGIN = 'http://127.0.0.2:3441';
const INNER_ORIGIN = 'http://127.0.0.3:3442';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const identity = {
  channelId: 'BBBBBBBBBBBBBBBBBBBBBB',
  sessionId: 'CCCCCCCCCCCCCCCCCCCCCC',
  artifact: { artifactId: 'artifact_one', versionId: 'version_one' },
};

const innerBuild = await build({
  entryPoints: [new URL('../packages/artifact-runtime/src/runner/inner-bootstrap.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
});
const innerSource = new TextDecoder().decode(innerBuild.outputFiles[0].contents);

const innerDocument = ({ resources, prelude = '' }) => `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${NONCE}' blob: ${INNER_ORIGIN}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}</style>
<template id="__sceneboard_artifact_resources_v1__">${JSON.stringify(resources).replaceAll('<', '\\u003c')}</template>
${prelude === '' ? '' : `<script nonce="${NONCE}">${prelude}</script>`}
<script nonce="${NONCE}" src="${INNER_ORIGIN}/inner.js"></script>
</head><body><main style="width:1200px;height:675px">artifact</main></body></html>`;

const outerDocument = `<!doctype html><html><body><script>
const identity = ${JSON.stringify(identity)};
const frame = document.createElement('iframe');
frame.id = 'inner';
frame.setAttribute('sandbox', 'allow-scripts');
document.body.append(frame);
frame.addEventListener('load', () => {
  const channel = new MessageChannel();
  window.__disposeInner = () => channel.port1.postMessage({ protocolVersion: 1, type: 'artifact.bridge', ...identity, sequence: 2, message: { type: 'host.dispose' } });
  channel.port1.onmessage = (event) => window.top.postMessage({ type: 'inner-message', message: event.data?.message }, '*');
  channel.port1.start();
  frame.contentWindow.postMessage({ protocolVersion: 1, type: 'artifact.bridge', ...identity, sequence: 1, message: { type: 'host.inner.init', policyEpoch: 'DDDDDDDDDDDDDDDDDDDDDD', requestedCapabilities: [] } }, '*', [channel.port2]);
}, { once: true });
frame.src = '${INNER_ORIGIN}/inner';
</script></body></html>`;

const appDocument = `<!doctype html><html><body>
<iframe id="outer" sandbox="allow-scripts" src="${OUTER_ORIGIN}/outer"></iframe>
<script>window.__messages = []; window.addEventListener('message', (event) => {
  if (event.data?.type === 'inner-message' && event.data.message) window.__messages.push(event.data.message.type);
});</script></body></html>`;

const openHarness = async (context, documentBody) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  await browserContext.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === APP_ORIGIN) return route.fulfill({ contentType: 'text/html', body: appDocument });
    if (url.origin === OUTER_ORIGIN) return route.fulfill({ contentType: 'text/html', body: outerDocument });
    if (url.origin === INNER_ORIGIN && url.pathname === '/inner') return route.fulfill({ contentType: 'text/html', body: documentBody });
    if (url.origin === INNER_ORIGIN && url.pathname === '/inner.js') return route.fulfill({ contentType: 'application/javascript', body: innerSource });
    return route.abort('blockedbyclient');
  });
  const page = await browserContext.newPage();
  await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'load' });
  const outer = page.frames().find((frame) => frame.url() === `${OUTER_ORIGIN}/outer`);
  const inner = page.frames().find((frame) => frame.url() === `${INNER_ORIGIN}/inner`);
  assert.ok(outer);
  assert.ok(inner);
  return { page, outer, inner };
};

test('inner disposal wins a deferred Mermaid continuation', { timeout: 15_000 }, async (context) => {
  const harness = await openHarness(context, innerDocument({
    resources: { css: null, javascript: 'window.__authoredMainRan = true;', diagram: true },
    prelude: `window.__mermaidStarted = false; window.__scheduledFrames = 0; window.__blobUrlsCreated = 0; const nativeRaf = window.requestAnimationFrame; const nativeCreateObjectURL = URL.createObjectURL; window.requestAnimationFrame = (callback) => { window.__scheduledFrames += 1; return nativeRaf(callback); }; URL.createObjectURL = function(...args) { window.__blobUrlsCreated += 1; return nativeCreateObjectURL.apply(this, args); }; window.mermaid = { initialize() {}, run() { window.__mermaidStarted = true; return new Promise((resolve) => { window.__resolveMermaid = resolve; }); } };`,
  }));
  await harness.inner.waitForFunction(() => window.__mermaidStarted === true);
  await harness.outer.evaluate(() => window.__disposeInner());
  await harness.page.waitForFunction(() => window.__messages.includes('peer.disposed'));
  await harness.inner.evaluate(() => window.__resolveMermaid());
  await harness.page.waitForTimeout(75);
  assert.deepEqual(await harness.page.evaluate(() => window.__messages), ['peer.disposed']);
  assert.equal(await harness.inner.evaluate(() => window.__scheduledFrames), 0);
  assert.equal(await harness.inner.evaluate(() => window.__blobUrlsCreated), 0);
});

test('inner disposal wins a deferred authored script load', { timeout: 15_000 }, async (context) => {
  const harness = await openHarness(context, innerDocument({
    resources: { css: null, javascript: 'window.__authoredMainRan = true;', diagram: false },
    prelude: `window.__pendingScript = null; window.__scheduledFrames = 0; window.__scriptRemovals = 0; window.__urlRevocations = 0; const nativeRaf = window.requestAnimationFrame; const nativeRemove = Element.prototype.remove; const nativeRevokeObjectURL = URL.revokeObjectURL; window.requestAnimationFrame = (callback) => { window.__scheduledFrames += 1; return nativeRaf(callback); }; Element.prototype.remove = function() { if (this === window.__pendingScript) window.__scriptRemovals += 1; return nativeRemove.apply(this, arguments); }; URL.revokeObjectURL = function(...args) { window.__urlRevocations += 1; return nativeRevokeObjectURL.apply(this, args); }; const nativeAppend = HTMLElement.prototype.append; HTMLElement.prototype.append = function(...nodes) { const script = nodes.find((node) => node instanceof HTMLScriptElement && node.src.startsWith('blob:')); if (script) { window.__pendingScript = script; return; } return nativeAppend.apply(this, nodes); };`,
  }));
  await harness.inner.waitForFunction(() => window.__pendingScript instanceof HTMLScriptElement);
  await harness.outer.evaluate(() => window.__disposeInner());
  await harness.page.waitForFunction(() => window.__messages.includes('peer.disposed'));
  await harness.inner.evaluate(() => window.__pendingScript.dispatchEvent(new Event('load')));
  await harness.page.waitForTimeout(75);
  assert.deepEqual(await harness.page.evaluate(() => window.__messages), ['peer.disposed']);
  assert.equal(await harness.inner.evaluate(() => window.__authoredMainRan === true), false);
  assert.equal(await harness.inner.evaluate(() => window.__scheduledFrames), 0);
  assert.equal(await harness.inner.evaluate(() => window.__scriptRemovals), 1);
  assert.equal(await harness.inner.evaluate(() => window.__urlRevocations), 1);
});

const manualFramePrelude = `window.__frameHarness = { nextId: 1, queued: [], cancelled: [], observerConstructed: 0, geometryReads: 0 }; const nativeRect = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function() { window.__frameHarness.geometryReads += 1; return nativeRect.apply(this, arguments); }; window.requestAnimationFrame = (callback) => { const id = window.__frameHarness.nextId++; window.__frameHarness.queued.push({ id, callback }); return id; }; window.cancelAnimationFrame = (id) => { window.__frameHarness.cancelled.push(id); }; window.ResizeObserver = class { constructor() { window.__frameHarness.observerConstructed += 1; } observe() {} disconnect() {} }; window.__runFrame = () => { const entry = window.__frameHarness.queued.shift(); if (entry) entry.callback(performance.now()); return entry?.id ?? null; };`;

test('inner disposal cancels and guards the first deferred measurement frame', { timeout: 15_000 }, async (context) => {
  const harness = await openHarness(context, innerDocument({ resources: { css: null, javascript: null, diagram: false }, prelude: manualFramePrelude }));
  await harness.page.waitForFunction(() => window.__messages.includes('artifact.ready'));
  assert.deepEqual(await harness.inner.evaluate(() => window.__frameHarness.queued.map((entry) => entry.id)), [1]);
  await harness.outer.evaluate(() => window.__disposeInner());
  await harness.page.waitForFunction(() => window.__messages.includes('peer.disposed'));
  assert.deepEqual(await harness.inner.evaluate(() => window.__frameHarness.cancelled), [1]);
  await harness.inner.evaluate(() => window.__runFrame());
  assert.equal(await harness.inner.evaluate(() => window.__frameHarness.queued.length), 0);
  assert.equal(await harness.inner.evaluate(() => window.__frameHarness.observerConstructed), 0);
  assert.equal(await harness.inner.evaluate(() => window.__frameHarness.geometryReads), 0);
  assert.deepEqual(await harness.page.evaluate(() => window.__messages), ['artifact.ready', 'peer.disposed']);
});

test('inner disposal cancels and guards the second deferred measurement frame', { timeout: 15_000 }, async (context) => {
  const harness = await openHarness(context, innerDocument({ resources: { css: null, javascript: null, diagram: false }, prelude: manualFramePrelude }));
  await harness.page.waitForFunction(() => window.__messages.includes('artifact.ready'));
  assert.equal(await harness.inner.evaluate(() => window.__runFrame()), 1);
  assert.deepEqual(await harness.inner.evaluate(() => window.__frameHarness.queued.map((entry) => entry.id)), [2]);
  await harness.outer.evaluate(() => window.__disposeInner());
  await harness.page.waitForFunction(() => window.__messages.includes('peer.disposed'));
  assert.deepEqual(await harness.inner.evaluate(() => window.__frameHarness.cancelled), [2]);
  await harness.inner.evaluate(() => window.__runFrame());
  assert.equal(await harness.inner.evaluate(() => window.__frameHarness.observerConstructed), 0);
  assert.equal(await harness.inner.evaluate(() => window.__frameHarness.geometryReads), 0);
  assert.deepEqual(await harness.page.evaluate(() => window.__messages), ['artifact.ready', 'peer.disposed']);
});
