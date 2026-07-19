import {
  ArtifactBridgeEndpointV1,
  ArtifactRunnerStateMachineV1,
  parseArtifactBridgeEnvelopeV1,
  type ArtifactBridgeEnvelopeV1,
  type ArtifactBridgeMessageV1,
} from '../bridge/index.js';
import type { ArtifactReferenceV1 } from '@leecat-board/board-schema';
import { decodeArtifactPackageV1 } from '../package/index.js';
import { buildInnerPolicyV1, INNER_SANDBOX_TOKENS_V1 } from '../policy/index.js';

declare const __INNER_BOOTSTRAP_SOURCE__: string;
declare const __MERMAID_ASSET_PATH__: string;

type BinaryCarrier = { envelope: ArtifactBridgeEnvelopeV1; binary: ArrayBuffer };

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const escapeAttribute = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const safeScriptString = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

let parentPort: MessagePort | null = null;
let parentEndpoint: ArtifactBridgeEndpointV1 | null = null;
let bridgeIdentity: { channelId: string; sessionId: string; artifact: ArtifactReferenceV1 } | null = null;
let policyEpoch: string | null = null;
let innerPort: MessagePort | null = null;
let innerEndpoint: ArtifactBridgeEndpointV1 | null = null;
let innerFrame: HTMLIFrameElement | null = null;
let innerDocumentUrl: string | null = null;
let packageBytes: Uint8Array | null = null;
let expectedTransfer: { id: string; totalBytes: number; chunkCount: number; packageSha256: string; received: number; nextIndex: number } | null = null;
let disposed = false;
const lifecycle = new ArtifactRunnerStateMachineV1();

const sendParent = (message: ArtifactBridgeMessageV1): void => {
  if (disposed || parentEndpoint === null || parentPort === null) return;
  parentPort.postMessage(parentEndpoint.send(message));
};

const terminalDispose = (notify = true): void => {
  if (disposed) return;
  if (innerEndpoint !== null && innerPort !== null && !innerEndpoint.closed) {
    try { innerPort.postMessage(innerEndpoint.send({ type: 'host.dispose', reason: 'protocol_error' })); } catch { /* terminal */ }
  }
  if (notify && parentEndpoint !== null && parentPort !== null) {
    try { parentPort.postMessage(parentEndpoint.send({ type: 'peer.disposed' })); } catch { /* terminal */ }
  }
  disposed = true;
  parentPort?.close();
  innerPort?.close();
  parentEndpoint?.close();
  innerEndpoint?.close();
  innerFrame?.remove();
  if (innerDocumentUrl !== null) URL.revokeObjectURL(innerDocumentUrl);
  if (packageBytes !== null) packageBytes.fill(0);
  packageBytes = null;
  expectedTransfer = null;
};

const createInner = async (message: Extract<ArtifactBridgeMessageV1, { type: 'host.inner.init' }>): Promise<void> => {
  if (packageBytes === null || parentEndpoint === null || bridgeIdentity === null) throw new TypeError('certified package is unavailable');
  const decoded = await decodeArtifactPackageV1(packageBytes);
  const html = decoded.resources.find((resource) => resource.path === 'index.html');
  const css = decoded.resources.find((resource) => resource.path === 'styles.css');
  const javascript = decoded.resources.find((resource) => resource.path === 'main.js');
  if (html === undefined) throw new TypeError('artifact entry resource is missing');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const htmlText = decoder.decode(html.bytes);
  const cssText = css === undefined ? null : decoder.decode(css.bytes);
  const javascriptText = javascript === undefined ? null : decoder.decode(javascript.bytes);
  const diagram = /<pre\s+[^>]*class=(?:"[^"]*\bmermaid\b[^"]*"|'[^']*\bmermaid\b[^']*')[^>]*>/iu.test(htmlText);
  const nonce = randomId();
  const policy = buildInnerPolicyV1(nonce);
  const resources = safeScriptString({ css: cssText, javascript: javascriptText, diagram });
  const bootstrapBytes = new TextEncoder().encode(__INNER_BOOTSTRAP_SOURCE__);
  let bootstrapBinary = '';
  for (const byte of bootstrapBytes) bootstrapBinary += String.fromCharCode(byte);
  const bootstrapDataUrl = `data:application/javascript;base64,${btoa(bootstrapBinary)}`;
  const mermaidTag = diagram
    ? `<script nonce="${nonce}" src="${escapeAttribute(new URL(__MERMAID_ASSET_PATH__, window.location.href).href)}"></script>`
    : '';
  const resourcesTag = `<template id="__sceneboard_artifact_resources_v1__">${resources}</template>`;
  const bootstrapTag = `<script nonce="${nonce}" src="${escapeAttribute(bootstrapDataUrl)}"></script>`;
  const documentBytes = new TextEncoder().encode(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden}</style>${mermaidTag}${resourcesTag}</head><body>${htmlText}${bootstrapTag}</body></html>`);
  innerDocumentUrl = URL.createObjectURL(new Blob([documentBytes], { type: 'text/html' }));
  const frame = document.createElement('iframe');
  frame.title = 'Isolated artifact content';
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('sandbox', INNER_SANDBOX_TOKENS_V1);
  innerFrame = frame;
  document.body.replaceChildren(frame);
  const channel = new MessageChannel();
  innerPort = channel.port1;
  innerEndpoint = new ArtifactBridgeEndpointV1({
    channelId: bridgeIdentity.channelId,
    sessionId: bridgeIdentity.sessionId,
    artifact: bridgeIdentity.artifact,
  });
  innerPort.onmessage = (event: MessageEvent<ArtifactBridgeEnvelopeV1>) => {
    if (innerEndpoint === null) return;
    const incoming = innerEndpoint.receive(event.data).envelope.message;
    if (incoming.type === 'artifact.ready') {
      lifecycle.receive('artifact.ready');
      sendParent(incoming);
      return;
    }
    if (incoming.type === 'artifact.resize.request') {
      sendParent(incoming);
      return;
    }
    if (incoming.type === 'peer.disposed') terminalDispose();
  };
  frame.addEventListener('load', () => {
    if (frame.contentWindow === null || innerEndpoint === null) return terminalDispose();
    const envelope = innerEndpoint.send(message, { messagePorts: 1, arrayBufferBytes: [] });
    frame.contentWindow.postMessage(envelope, '*', [channel.port2]);
    innerPort?.start();
  }, { once: true });
  frame.src = innerDocumentUrl;
};

const handleParentMessage = async (event: MessageEvent<unknown>): Promise<void> => {
  if (parentEndpoint === null) return;
  let source: unknown = event.data;
  let transfer = { messagePorts: 0, arrayBufferBytes: [] as number[] };
  let binary: ArrayBuffer | null = null;
  if (event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)
    && Object.keys(event.data).length === 2 && Object.hasOwn(event.data, 'envelope') && Object.hasOwn(event.data, 'binary')) {
    const carrier = event.data as BinaryCarrier;
    if (!(carrier.binary instanceof ArrayBuffer)) throw new TypeError('binary carrier is invalid');
    source = carrier.envelope;
    binary = carrier.binary;
    transfer = { messagePorts: 0, arrayBufferBytes: [binary.byteLength] };
  }
  const parsed = parentEndpoint.receive(source, transfer);
  const message = parsed.envelope.message;
  if (message.type === 'host.dispose') {
    terminalDispose();
    return;
  }
  if (message.type === 'host.watchdog.ping') {
    sendParent({ type: 'runner.watchdog.pong', watchdogId: message.watchdogId, sentAtMonotonicMs: message.sentAtMonotonicMs });
    return;
  }
  lifecycle.receive(message.type);
  if (message.type === 'host.package.start') {
    expectedTransfer = { id: message.transferId, totalBytes: message.totalBytes, chunkCount: message.chunkCount, packageSha256: message.packageSha256, received: 0, nextIndex: 0 };
    packageBytes = new Uint8Array(message.totalBytes);
    return;
  }
  if (message.type === 'host.package.chunk') {
    if (binary === null || expectedTransfer === null || packageBytes === null
      || message.transferId !== expectedTransfer.id
      || message.index !== expectedTransfer.nextIndex
      || message.offset !== expectedTransfer.received
      || message.offset + binary.byteLength > packageBytes.byteLength) throw new TypeError('package chunk is out of sequence');
    packageBytes.set(new Uint8Array(binary), message.offset);
    expectedTransfer.received += binary.byteLength;
    expectedTransfer.nextIndex += 1;
    sendParent({ type: 'runner.package.ack', transferId: message.transferId, index: message.index, receivedBytes: expectedTransfer.received });
    return;
  }
  if (message.type === 'host.package.end') {
    if (expectedTransfer === null || packageBytes === null
      || message.transferId !== expectedTransfer.id
      || message.chunkCount !== expectedTransfer.chunkCount
      || message.totalBytes !== expectedTransfer.totalBytes
      || message.packageSha256 !== expectedTransfer.packageSha256
      || expectedTransfer.received !== expectedTransfer.totalBytes
      || expectedTransfer.nextIndex !== expectedTransfer.chunkCount) throw new TypeError('package transfer did not complete exactly');
    const decoded = await decodeArtifactPackageV1(packageBytes);
    if (decoded.packageSha256 !== message.packageSha256
      || decoded.manifest.artifact.artifactId !== parsed.envelope.artifact.artifactId
      || decoded.manifest.artifact.versionId !== parsed.envelope.artifact.versionId) throw new TypeError('package identity certification failed');
    sendParent({ type: 'runner.package.ready', transferId: message.transferId, packageSha256: decoded.packageSha256 });
    if (policyEpoch === null) throw new TypeError('runtime policy epoch is unavailable');
    const innerInit: Extract<ArtifactBridgeMessageV1, { type: 'host.inner.init' }> = {
      type: 'host.inner.init',
      policyEpoch,
      requestedCapabilities: [...decoded.manifest.requestedCapabilities],
    };
    lifecycle.receive('host.inner.init');
    await createInner(innerInit);
    return;
  }
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (parentEndpoint !== null || event.source !== window.parent || event.ports.length !== 1) return;
  const parsed = parseArtifactBridgeEnvelopeV1(event.data, { messagePorts: 1, arrayBufferBytes: [] });
  if (parsed.envelope.message.type !== 'host.bootstrap'
    || event.origin !== parsed.envelope.message.appOrigin
    || new URL(window.location.href).origin !== parsed.envelope.message.runtimeOrigin) return;
  parentEndpoint = new ArtifactBridgeEndpointV1({
    channelId: parsed.envelope.channelId,
    sessionId: parsed.envelope.sessionId,
    artifact: parsed.envelope.artifact,
  });
  bridgeIdentity = {
    channelId: parsed.envelope.channelId,
    sessionId: parsed.envelope.sessionId,
    artifact: parsed.envelope.artifact,
  };
  policyEpoch = parsed.envelope.message.policyEpoch;
  parentEndpoint.receive(event.data, { messagePorts: 1, arrayBufferBytes: [] });
  lifecycle.receive('host.bootstrap');
  parentPort = event.ports[0] ?? null;
  if (parentPort === null) return;
  let queue = Promise.resolve();
  parentPort.onmessage = (portEvent) => {
    queue = queue.then(() => handleParentMessage(portEvent)).catch(() => terminalDispose());
  };
  parentPort.start();
  sendParent({ type: 'runner.ready', supportedProtocolVersions: [1] });
}, { once: true });
