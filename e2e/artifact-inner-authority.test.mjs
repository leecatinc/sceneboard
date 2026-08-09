import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3420';
const OUTER_ORIGIN = 'http://127.0.0.2:3421';
const identity = {
  channelId: 'BBBBBBBBBBBBBBBBBBBBBB',
  sessionId: 'CCCCCCCCCCCCCCCCCCCCCC',
  artifact: { artifactId: 'artifact_one', versionId: 'version_one' },
};

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
const makePackage = (javascript) => {
  const resources = [
    {
      path: 'index.html',
      mediaType: 'text/html',
      bytes: Buffer.from('<main style="width:1300.2px;height:700.1px">artifact</main>'),
    },
    { path: 'main.js', mediaType: 'application/javascript', bytes: Buffer.from(javascript) },
  ].map((resource) => ({
    ...resource,
    sha256: sha256(resource.bytes),
    byteLength: resource.bytes.byteLength,
  }));
  const manifest = {
    protocolVersion: 1,
    type: 'artifact.manifest',
    artifact: identity.artifact,
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
  const bytes = Buffer.concat(parts);
  return { bytes, manifestSha256: sha256(manifestBytes), packageSha256: sha256(bytes) };
};

const innerBuild = await build({
  entryPoints: [
    new URL('../packages/artifact-runtime/src/runner/inner-bootstrap.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
});
const innerSource = new TextDecoder().decode(innerBuild.outputFiles[0].contents);
const outerBuild = await build({
  entryPoints: [
    new URL('../packages/artifact-runtime/src/runner/outer.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  define: {
    __INNER_BOOTSTRAP_SOURCE__: JSON.stringify(innerSource),
    __MERMAID_ASSET_PATH__: JSON.stringify('/mermaid.js'),
  },
});
const outerSource = new TextDecoder().decode(outerBuild.outputFiles[0].contents);

const hostileMain = `
globalThis.__authorityProbe = { data: false, ports: false, keys: false, ownKeys: false, postMessage: false, call: false, hostMessages: [], hostBinaries: [], publicCalls: 0, publicKeys: [], unexpectedPublicKeys: [], publicResults: [], recoveredAuthority: false, forgedWithRecoveredAuthority: false, downloadDetached: false, wheelClient: null, panClient: { start: null, end: null } };
const probe = globalThis.__authorityProbe;
const dataDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
const portsDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports');
Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() { probe.data = true; return Reflect.apply(dataDescriptor.get, this, []); } });
Object.defineProperty(MessageEvent.prototype, 'ports', { configurable: true, get() { probe.ports = true; return Reflect.apply(portsDescriptor.get, this, []); } });
const objectKeys = Object.keys;
Object.keys = function(value) { if (value?.type === 'artifact.bridge') probe.keys = true; return objectKeys(value); };
const reflectOwnKeys = Reflect.ownKeys;
Reflect.ownKeys = function(value) { if (value?.type === 'artifact.bridge') probe.ownKeys = true; return reflectOwnKeys(value); };
const nativePostMessage = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function(...args) { probe.postMessage = true; return Reflect.apply(nativePostMessage, this, args); };
const nativeCall = Function.prototype.call;
Function.prototype.call = function(...args) { probe.call = true; return Reflect.apply(nativeCall, this, args); };
const trustedPrimitives = {
  max: Math.max, min: Math.min, isFinite: Number.isFinite, isInteger: Number.isInteger,
  button: Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'button'),
  buttons: Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'buttons'),
  clientX: Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'clientX'),
  clientY: Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'clientY'),
  pointerId: Object.getOwnPropertyDescriptor(PointerEvent.prototype, 'pointerId'),
  deltaY: Object.getOwnPropertyDescriptor(WheelEvent.prototype, 'deltaY'),
  deltaMode: Object.getOwnPropertyDescriptor(WheelEvent.prototype, 'deltaMode'),
  cancelable: Object.getOwnPropertyDescriptor(Event.prototype, 'cancelable'),
  preventDefault: Object.getOwnPropertyDescriptor(Event.prototype, 'preventDefault'),
  innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
  innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
  setPointerCapture: Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture'),
  hasPointerCapture: Object.getOwnPropertyDescriptor(Element.prototype, 'hasPointerCapture'),
  releasePointerCapture: Object.getOwnPropertyDescriptor(Element.prototype, 'releasePointerCapture'),
  performance: Object.getOwnPropertyDescriptor(window, 'performance'),
  documentElement: Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement'),
  globalThis: Object.getOwnPropertyDescriptor(window, 'globalThis'),
};
const readMouse = (descriptor, event) => Reflect.apply(descriptor.get, event, []);
window.addEventListener('wheel', (event) => { if (event.isTrusted) { probe.wheelClient = { x: readMouse(trustedPrimitives.clientX, event), y: readMouse(trustedPrimitives.clientY, event) }; probe.call = false; } });
window.addEventListener('pointerdown', (event) => { if (event.isTrusted && readMouse(trustedPrimitives.button, event) === 1) probe.panClient.start = { x: readMouse(trustedPrimitives.clientX, event), y: readMouse(trustedPrimitives.clientY, event) }; });
window.addEventListener('pointerup', (event) => { if (event.isTrusted && readMouse(trustedPrimitives.button, event) === 1) probe.panClient.end = { x: readMouse(trustedPrimitives.clientX, event), y: readMouse(trustedPrimitives.clientY, event) }; });
const expectedPublicKeys = ['changePresentationPage', 'changeSelection', 'onHostMessage', 'requestCapability', 'requestResize', 'userAction'];
probe.publicKeys = reflectOwnKeys(SceneBoardArtifact).map(String).sort();
probe.unexpectedPublicKeys = probe.publicKeys.filter((key) => !expectedPublicKeys.includes(key));
const unsubscribe = SceneBoardArtifact.onHostMessage((message, binary) => { probe.hostMessages.push(message.type); probe.hostBinaries.push(binary ? [...new Uint8Array(binary)] : null); });
probe.publicResults.push(typeof unsubscribe);
probe.publicResults.push(String(SceneBoardArtifact.requestResize(900, 600))); probe.publicCalls += 1;
probe.publicResults.push(String(SceneBoardArtifact.changeSelection(['node_one']))); probe.publicCalls += 1;
probe.publicResults.push(String(SceneBoardArtifact.userAction('FFFFFFFFFFFFFFFFFFFFFF', 'fullscreen'))); probe.publicCalls += 1;
probe.publicResults.push(String(SceneBoardArtifact.requestCapability('GGGGGGGGGGGGGGGGGGGGGG', 'fullscreen', {}))); probe.publicCalls += 1;
const leakedPort = typeof SceneBoardArtifact.leakPort === 'function' ? SceneBoardArtifact.leakPort() : null;
const leakedIdentity = typeof SceneBoardArtifact.leakIdentity === 'function' ? SceneBoardArtifact.leakIdentity() : null;
const leakedSequence = typeof SceneBoardArtifact.leakSequence === 'function' ? SceneBoardArtifact.leakSequence() : null;
probe.recoveredAuthority = leakedPort instanceof MessagePort || leakedIdentity !== null || Number.isInteger(leakedSequence);
if (leakedPort instanceof MessagePort && leakedIdentity && Number.isInteger(leakedSequence)) {
  probe.forgedWithRecoveredAuthority = true;
  Reflect.apply(nativePostMessage, leakedPort, [{ protocolVersion: 1, type: 'artifact.bridge', ...leakedIdentity, sequence: leakedSequence, message: { type: 'artifact.navigation.wheel', xMillionth: 500000, yMillionth: 500000, deltaY: -120 } }]);
}
window.postMessage({ protocolVersion: 1, type: 'artifact.bridge', channelId: 'BBBBBBBBBBBBBBBBBBBBBB', sessionId: 'CCCCCCCCCCCCCCCCCCCCCC', artifact: { artifactId: 'artifact_one', versionId: 'version_one' }, sequence: 2, message: { type: 'host.navigation.set', enabled: false } }, '*');
globalThis.__floodAuthoredLane = () => {
  for (let index = 0; index < 80; index += 1) SceneBoardArtifact.requestResize(100 + index, 100 + index);
  SceneBoardArtifact.requestResize(777, 555);
};
globalThis.__syntheticNavigation = () => {
  window.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 200, clientY: 150, bubbles: true, cancelable: true }));
  window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button: 1, buttons: 4, clientX: 200, clientY: 150, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, buttons: 4, clientX: 240, clientY: 180, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, button: 1, clientX: 240, clientY: 180, bubbles: true }));
};
globalThis.__requestDownload = () => { const bytes = new Uint8Array([1, 3, 5, 7]).buffer; SceneBoardArtifact.requestCapability('HHHHHHHHHHHHHHHHHHHHHH', 'download', { byteLength: 4, filename: 'demo.bin' }, bytes); probe.downloadDetached = bytes.byteLength === 0; };
globalThis.__largeSelectionFlood = () => { const ids = Array.from({ length: 100 }, (_, index) => ('node_' + String(index).padStart(3, '0') + '_').padEnd(64, 'x')); for (let index = 0; index < 45; index += 1) SceneBoardArtifact.changeSelection(ids); };
globalThis.__poisonNumericPrimitives = () => {
  Math.max = () => 0; Math.min = () => 0; Number.isFinite = () => false; Number.isInteger = () => false;
  Object.defineProperty(window, 'globalThis', { configurable: true, value: Object.create(window) });
  Object.defineProperty(window, 'performance', { configurable: true, value: {} });
  Object.defineProperty(Document.prototype, 'documentElement', { configurable: true, get: () => null });
  Object.defineProperty(MouseEvent.prototype, 'button', { configurable: true, get: () => 0 });
  Object.defineProperty(MouseEvent.prototype, 'buttons', { configurable: true, get: () => 1 });
  Object.defineProperty(MouseEvent.prototype, 'clientX', { configurable: true, get: () => 1 });
  Object.defineProperty(MouseEvent.prototype, 'clientY', { configurable: true, get: () => 1 });
  Object.defineProperty(PointerEvent.prototype, 'pointerId', { configurable: true, get: () => 999 });
  Object.defineProperty(WheelEvent.prototype, 'deltaY', { configurable: true, get: () => 1 });
  Object.defineProperty(WheelEvent.prototype, 'deltaMode', { configurable: true, get: () => 2 });
  Object.defineProperty(Event.prototype, 'cancelable', { configurable: true, get: () => false });
  Object.defineProperty(Event.prototype, 'preventDefault', { configurable: true, value: () => { throw new Error('poisoned preventDefault'); } });
  Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 1 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 1 });
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => { throw new Error('poisoned setPointerCapture'); } });
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: () => { throw new Error('poisoned releasePointerCapture'); } });
};
globalThis.__restoreNumericPrimitives = () => {
  Math.max = trustedPrimitives.max; Math.min = trustedPrimitives.min; Number.isFinite = trustedPrimitives.isFinite; Number.isInteger = trustedPrimitives.isInteger;
  for (const [owner, key] of [[MouseEvent.prototype, 'button'], [MouseEvent.prototype, 'buttons'], [MouseEvent.prototype, 'clientX'], [MouseEvent.prototype, 'clientY'], [PointerEvent.prototype, 'pointerId'], [WheelEvent.prototype, 'deltaY'], [WheelEvent.prototype, 'deltaMode'], [Event.prototype, 'cancelable'], [Event.prototype, 'preventDefault'], [window, 'innerWidth'], [window, 'innerHeight'], [Element.prototype, 'setPointerCapture'], [Element.prototype, 'hasPointerCapture'], [Element.prototype, 'releasePointerCapture'], [window, 'performance'], [Document.prototype, 'documentElement'], [window, 'globalThis']]) Object.defineProperty(owner, key, trustedPrimitives[key]);
};
`;
const artifactPackage = makePackage(hostileMain);
const packageBase64 = artifactPackage.bytes.toString('base64');

const outerDocument =
  '<!doctype html><html><body style="margin:0"><script src="/outer.js"></script></body></html>';
const appDocument = `<!doctype html><html><body>
<iframe id="outer" sandbox="allow-scripts" src="${OUTER_ORIGIN}/runner" style="width:700px;height:500px;border:0"></iframe>
<script>
const identity = ${JSON.stringify(identity)};
const packageBytes = Uint8Array.from(atob('${packageBase64}'), (value) => value.charCodeAt(0));
const frame = document.getElementById('outer');
const state = { outboundSequence: 1, inboundSequence: 1, messages: [], messageValues: [], navigation: 0, navigationValues: [], protocolErrors: 0, protocolErrorCodes: [], receivedBinaries: [], sentBinaryDetached: null };
window.__stackState = state;
frame.addEventListener('load', () => {
  const channel = new MessageChannel();
  const send = (message, binary) => {
    const envelope = { protocolVersion: 1, type: 'artifact.bridge', ...identity, sequence: state.outboundSequence++, message };
    if (binary === undefined) channel.port1.postMessage(envelope);
    else channel.port1.postMessage({ envelope, binary }, [binary]);
  };
  window.__sendNetworkResult = () => {
    const binary = new Uint8Array([2, 4, 6, 8]).buffer;
    send({ type: 'host.capability.result', requestId: 'IIIIIIIIIIIIIIIIIIIIII', capability: 'network.fetch', ok: true, result: { byteLength: 4 } }, binary);
    state.sentBinaryDetached = binary.byteLength === 0;
  };
  window.__setNavigation = (enabled) => send({ type: 'host.navigation.set', enabled });
  channel.port1.onmessage = (event) => {
    const envelope = event.data?.envelope ?? event.data;
    const binary = event.data?.binary;
    if (!envelope || envelope.sequence !== state.inboundSequence++) return;
    const message = envelope.message;
    state.messages.push(message.type);
    state.messageValues.push(message);
    if (binary instanceof ArrayBuffer) state.receivedBinaries.push([...new Uint8Array(binary)]);
    if (message.type.startsWith('artifact.navigation.')) { state.navigation += 1; state.navigationValues.push(message); }
    if (message.type === 'protocol.error') { state.protocolErrors += 1; state.protocolErrorCodes.push(message.code); }
    if (message.type === 'runner.ready') send({ type: 'host.package.start', transferId: 'EEEEEEEEEEEEEEEEEEEEEE', totalBytes: packageBytes.byteLength, chunkBytes: 262144, chunkCount: 1, manifestSha256: '${artifactPackage.manifestSha256}', packageSha256: '${artifactPackage.packageSha256}' });
    else if (message.type === 'runner.package.ack') {
      const copy = packageBytes.slice().buffer;
      send({ type: 'host.package.end', transferId: 'EEEEEEEEEEEEEEEEEEEEEE', chunkCount: 1, totalBytes: packageBytes.byteLength, packageSha256: '${artifactPackage.packageSha256}' });
    } else if (message.type === 'runner.package.ready') {
      // The chunk must precede the end; send it before this branch can be reached.
    } else if (message.type === 'artifact.ready') {
      send({ type: 'host.navigation.set', enabled: true });
      document.body.dataset.ready = 'true';
    }
  };
  channel.port1.start();
  const bootstrap = { protocolVersion: 1, type: 'artifact.bridge', ...identity, sequence: state.outboundSequence++, message: { type: 'host.bootstrap', appOrigin: '${APP_ORIGIN}', runtimeOrigin: '${OUTER_ORIGIN}', policyEpoch: 'DDDDDDDDDDDDDDDDDDDDDD' } };
  frame.contentWindow.postMessage(bootstrap, '*', [channel.port2]);
  const startTransfer = () => {
    if (!state.messages.includes('runner.ready')) return setTimeout(startTransfer, 0);
    const copy = packageBytes.slice().buffer;
    send({ type: 'host.package.chunk', transferId: 'EEEEEEEEEEEEEEEEEEEEEE', index: 0, offset: 0, byteLength: packageBytes.byteLength }, copy);
  };
  startTransfer();
}, { once: true });
</script></body></html>`;

test(
  'production outer and inner keep hostile authored code outside the private authority lane',
  { timeout: 20_000 },
  async (context) => {
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const browserContext = await browser.newContext();
    await browserContext.addInitScript(
      ({ outerOrigin }) => {
        if (location.origin === outerOrigin)
          Object.defineProperty(Performance.prototype, 'now', {
            configurable: true,
            value: () => 1_000,
          });
      },
      { outerOrigin: OUTER_ORIGIN },
    );
    await browserContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === APP_ORIGIN)
        return route.fulfill({ contentType: 'text/html', body: appDocument });
      if (url.origin === OUTER_ORIGIN && url.pathname === '/runner')
        return route.fulfill({ contentType: 'text/html', body: outerDocument });
      if (url.origin === OUTER_ORIGIN && url.pathname === '/outer.js')
        return route.fulfill({ contentType: 'application/javascript', body: outerSource });
      return route.abort('blockedbyclient');
    });

    const page = await browserContext.newPage();
    await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'load' });
    await page
      .waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 5_000 })
      .catch(async (error) => {
        console.error(
          'authority harness state',
          await page.evaluate(() => ({
            state: window.__stackState,
            ready: document.body.dataset.ready,
          })),
          page.frames().map((frame) => frame.url()),
        );
        throw error;
      });
    const innerFrame = page.frames().find((frame) => frame.url().startsWith('blob:'));
    assert.ok(innerFrame);
    await innerFrame.waitForFunction(() => globalThis.__authorityProbe?.publicCalls === 4);
    assert.deepEqual(
      await innerFrame.evaluate(() => ({
        data: globalThis.__authorityProbe.data,
        ports: globalThis.__authorityProbe.ports,
        keys: globalThis.__authorityProbe.keys,
        ownKeys: globalThis.__authorityProbe.ownKeys,
        postMessage: globalThis.__authorityProbe.postMessage,
        call: globalThis.__authorityProbe.call,
      })),
      { data: false, ports: false, keys: false, ownKeys: false, postMessage: false, call: false },
    );
    await innerFrame.evaluate(() => globalThis.__syntheticNavigation());
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.__stackState.navigation), 0);
    const box = await innerFrame.locator('body').boundingBox();
    assert.ok(box);
    const viewport = await innerFrame.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await innerFrame.evaluate(() => globalThis.__poisonNumericPrimitives());
    await page.mouse.move(box.x + viewport.width / 4, box.y + viewport.height / 4);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(() => window.__stackState.navigation === 1);
    const wheelClient = await innerFrame.evaluate(() => globalThis.__authorityProbe.wheelClient);
    assert.ok(wheelClient);
    assert.deepEqual(await page.evaluate(() => window.__stackState.navigationValues), [
      {
        type: 'artifact.navigation.wheel',
        xMillionth: Math.round((wheelClient.x / viewport.width) * 1_000_000),
        yMillionth: Math.round((wheelClient.y / viewport.height) * 1_000_000),
        deltaY: -120,
      },
    ]);
    await page.mouse.move(box.x + viewport.width / 3, box.y + viewport.height / 3);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + viewport.width / 3 + 30, box.y + viewport.height / 3 + 20);
    await page.mouse.up({ button: 'middle' });
    await page.waitForFunction(() =>
      window.__stackState.navigationValues.some(
        (message) => message.type === 'artifact.navigation.pan.end',
      ),
    );
    const panClient = await innerFrame.evaluate(() => globalThis.__authorityProbe.panClient);
    assert.ok(panClient.start);
    assert.ok(panClient.end);
    assert.deepEqual((await page.evaluate(() => window.__stackState.navigationValues)).slice(1), [
      {
        type: 'artifact.navigation.pan.start',
        pointerId: 1,
        xMillionth: Math.round((panClient.start.x / viewport.width) * 1_000_000),
        yMillionth: Math.round((panClient.start.y / viewport.height) * 1_000_000),
      },
      {
        type: 'artifact.navigation.pan.end',
        pointerId: 1,
        deltaX: panClient.end.x - panClient.start.x,
        deltaY: panClient.end.y - panClient.start.y,
      },
    ]);
    const navigationAfterMiddlePan = await page.evaluate(
      () => window.__stackState.navigationValues.length,
    );
    await page.mouse.move(box.x + viewport.width / 2, box.y + viewport.height / 2);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(box.x + viewport.width / 2 + 20, box.y + viewport.height / 2 + 15);
    await page.mouse.up({ button: 'left' });
    await page.waitForTimeout(25);
    assert.equal(
      await page.evaluate(() => window.__stackState.navigationValues.length),
      navigationAfterMiddlePan,
    );
    await innerFrame.evaluate(() => globalThis.__restoreNumericPrimitives());
    await page.mouse.move(box.x + viewport.width / 3, box.y + viewport.height / 3);
    await page.mouse.down({ button: 'middle' });
    await page.waitForFunction(
      () =>
        window.__stackState.navigationValues.filter(
          (message) => message.type === 'artifact.navigation.pan.start',
        ).length === 2,
    );
    await page.evaluate(() => window.__setNavigation(false));
    await page.waitForFunction(() =>
      window.__stackState.navigationValues.some(
        (message) => message.type === 'artifact.navigation.pan.cancel',
      ),
    );
    await page.mouse.up({ button: 'middle' });
    assert.equal(
      await page.evaluate(
        () =>
          window.__stackState.navigationValues.filter(
            (message) => message.type === 'artifact.navigation.pan.cancel',
          ).length,
      ),
      1,
    );
    await page.evaluate(() => window.__setNavigation(true));
    await page.waitForTimeout(25);

    const finalPanClient = await innerFrame.evaluate(() => globalThis.__authorityProbe.panClient);
    assert.deepEqual(
      await innerFrame.evaluate(() => ({
        ...globalThis.__authorityProbe,
        hostMessages: [...globalThis.__authorityProbe.hostMessages],
      })),
      {
        data: false,
        ports: false,
        keys: false,
        ownKeys: false,
        postMessage: false,
        call: true,
        hostMessages: [],
        hostBinaries: [],
        publicCalls: 4,
        publicKeys: [
          'changePresentationPage',
          'changeSelection',
          'onHostMessage',
          'requestCapability',
          'requestResize',
          'userAction',
        ],
        unexpectedPublicKeys: [],
        publicResults: ['function', 'undefined', 'undefined', 'undefined', 'undefined'],
        recoveredAuthority: false,
        forgedWithRecoveredAuthority: false,
        downloadDetached: false,
        wheelClient,
        panClient: finalPanClient,
      },
    );

    await page.waitForFunction(() => {
      const explicit = window.__stackState.messageValues.filter(
        (message) =>
          message.type === 'artifact.resize.request' && message.value.source === 'explicit',
      );
      return explicit.length > 1 && explicit.at(-1)?.value.width === 900;
    });
    assert.equal(
      await page.evaluate(
        () =>
          window.__stackState.messageValues.filter(
            (message) =>
              message.type === 'artifact.resize.request' && message.value.source === 'observer',
          ).length,
      ),
      0,
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.__stackState.messageValues
          .filter(
            (message) =>
              message.type === 'artifact.resize.request' && message.value.source === 'explicit',
          )
          .at(-1),
      ),
      {
        type: 'artifact.resize.request',
        value: { width: 900, height: 600, source: 'explicit' },
      },
    );

    await innerFrame.evaluate(() => globalThis.__requestDownload());
    await page.waitForFunction(() => window.__stackState.receivedBinaries.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__stackState.receivedBinaries), [
      [1, 3, 5, 7],
    ]);
    assert.equal(
      await innerFrame.evaluate(() => globalThis.__authorityProbe.downloadDetached),
      true,
    );
    await page.evaluate(() => window.__sendNetworkResult());
    await innerFrame.waitForFunction(() => globalThis.__authorityProbe.hostBinaries.length === 1);
    assert.deepEqual(
      await innerFrame.evaluate(() => ({
        messages: globalThis.__authorityProbe.hostMessages,
        binaries: globalThis.__authorityProbe.hostBinaries,
      })),
      {
        messages: ['host.capability.result'],
        binaries: [[2, 4, 6, 8]],
      },
    );
    assert.equal(await page.evaluate(() => window.__stackState.sentBinaryDetached), true);

    const acceptedBeforeFlood = await page.evaluate(
      () =>
        window.__stackState.messages.filter((type) => type === 'artifact.selection.change').length,
    );
    await innerFrame.evaluate(() => globalThis.__largeSelectionFlood());
    await page.waitForFunction(() => window.__stackState.protocolErrors === 1);
    const terminal = await page.evaluate(() => ({
      ...window.__stackState,
      messages: [...window.__stackState.messages],
    }));
    assert.equal(terminal.protocolErrors, 1);
    assert.deepEqual(terminal.protocolErrorCodes, ['rate']);
    const acceptedLargeSelections = await page.evaluate(
      (baseline) =>
        window.__stackState.messages.filter((type) => type === 'artifact.selection.change').length -
        baseline,
      acceptedBeforeFlood,
    );
    assert.equal(acceptedLargeSelections, 37);
    const countAtTerminal = terminal.messages.length;
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__stackState.messages.length), countAtTerminal);
  },
);
