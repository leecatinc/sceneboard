import {
  ArtifactBridgeEndpointV1,
  parseArtifactBridgeEnvelopeV1,
  type ArtifactBridgeEnvelopeV1,
  type ArtifactBridgeMessageV1,
} from '../bridge/index.js';

declare global {
  interface Window {
    SceneBoardArtifact?: Readonly<{
      onHostMessage(listener: (message: ArtifactBridgeMessageV1) => void): () => void;
      requestResize(width: number, height: number): void;
      changeSelection(nodeIds: string[]): void;
    }>;
    mermaid?: { initialize(input: { securityLevel: 'strict'; startOnLoad: false }): void; run(input: { querySelector: string }): Promise<void> };
  }
}

const resourcesElement = document.getElementById('__sceneboard_artifact_resources_v1__');
if (!(resourcesElement instanceof HTMLTemplateElement)) throw new TypeError('artifact resources are unavailable');
const resources = JSON.parse(resourcesElement.content.textContent ?? '') as {
  css: string | null;
  javascript: string | null;
  diagram: boolean;
};
resourcesElement.remove();
if ((resources.css !== null && typeof resources.css !== 'string')
  || (resources.javascript !== null && typeof resources.javascript !== 'string')
  || typeof resources.diagram !== 'boolean') throw new TypeError('artifact resources are invalid');

const hostListeners = new Set<(message: ArtifactBridgeMessageV1) => void>();
let endpoint: ArtifactBridgeEndpointV1 | null = null;
let port: MessagePort | null = null;
let scriptUrl: string | null = null;
let resizeObserver: ResizeObserver | null = null;
let hasExplicitResizeRequest = false;
let disposed = false;

const send = (message: ArtifactBridgeMessageV1): void => {
  if (disposed || endpoint === null || port === null) return;
  port.postMessage(endpoint.send(message));
};

const dispose = (): void => {
  if (disposed) return;
  disposed = true;
  if (endpoint !== null && port !== null) {
    try { port.postMessage(endpoint.send({ type: 'peer.disposed' })); } catch { /* terminal */ }
  }
  port?.close();
  endpoint?.close();
  if (scriptUrl !== null) URL.revokeObjectURL(scriptUrl);
  resizeObserver?.disconnect();
  hostListeners.clear();
};

window.SceneBoardArtifact = Object.freeze({
  onHostMessage(listener: (message: ArtifactBridgeMessageV1) => void): () => void {
    if (typeof listener !== 'function' || disposed) throw new TypeError('artifact host listener is invalid');
    hostListeners.add(listener);
    return () => hostListeners.delete(listener);
  },
  requestResize(width: number, height: number): void {
    hasExplicitResizeRequest = true;
    send({ type: 'artifact.resize.request', value: { width, height } });
  },
  changeSelection(nodeIds: string[]): void {
    send({ type: 'artifact.selection.change', value: { nodeIds } });
  },
});

const runArtifact = async (): Promise<void> => {
  if (resources.css !== null) {
    const style = document.createElement('style');
    style.textContent = resources.css;
    document.head.append(style);
  }
  if (resources.diagram && window.mermaid !== undefined) {
    window.mermaid.initialize({ securityLevel: 'strict', startOnLoad: false });
    await window.mermaid.run({ querySelector: 'pre.mermaid' });
  }
  if (resources.javascript !== null) {
    scriptUrl = URL.createObjectURL(new Blob([resources.javascript], { type: 'text/javascript' }));
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scriptUrl as string;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new TypeError('artifact script failed')), { once: true });
      document.body.append(script);
    });
  }
  const reportSize = (): void => {
    if (hasExplicitResizeRequest) return;
    let width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth);
    let height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight);
    for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
      const rect = element.getBoundingClientRect();
      width = Math.max(width, Math.max(0, rect.left) + element.scrollWidth, rect.right);
      height = Math.max(height, Math.max(0, rect.top) + element.scrollHeight, rect.bottom);
    }
    send({ type: 'artifact.resize.request', value: {
      width: Math.min(16_384, Math.max(1, Math.ceil(width))),
      height: Math.min(16_384, Math.max(1, Math.ceil(height))),
    } });
  };
  reportSize();
  resizeObserver = new ResizeObserver(reportSize);
  resizeObserver.observe(document.documentElement);
  resizeObserver.observe(document.body);
  send({ type: 'artifact.ready' });
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (endpoint !== null || event.source !== window.parent || event.origin !== 'null' || event.ports.length !== 1) return;
  const parsed = parseArtifactBridgeEnvelopeV1(event.data, { messagePorts: 1, arrayBufferBytes: [] });
  if (parsed.envelope.message.type !== 'host.inner.init') return;
  endpoint = new ArtifactBridgeEndpointV1({
    channelId: parsed.envelope.channelId,
    sessionId: parsed.envelope.sessionId,
    artifact: parsed.envelope.artifact,
  });
  endpoint.receive(event.data, { messagePorts: 1, arrayBufferBytes: [] });
  port = event.ports[0] ?? null;
  if (port === null) return;
  port.onmessage = (innerEvent: MessageEvent<ArtifactBridgeEnvelopeV1>) => {
    if (endpoint === null) return;
    const incoming = endpoint.receive(innerEvent.data).envelope.message;
    if (incoming.type === 'host.dispose') {
      dispose();
      return;
    }
    if (incoming.type === 'host.watchdog.ping') {
      send({ type: 'runner.watchdog.pong', watchdogId: incoming.watchdogId, sentAtMonotonicMs: incoming.sentAtMonotonicMs });
      return;
    }
    for (const listener of hostListeners) listener(incoming);
  };
  port.start();
  void runArtifact().catch(() => dispose());
}, { once: true });
