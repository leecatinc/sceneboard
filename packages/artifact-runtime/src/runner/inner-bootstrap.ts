import {
  ArtifactNavigationSchedulerV1,
  artifactPointerAnchorV1,
  measureArtifactContentSizeV1,
  normalizeArtifactWheelDeltaV1,
  parseArtifactBridgeEnvelopeV1,
  type ArtifactBridgeEnvelopeV1,
  type ArtifactBridgeMessageV1,
} from '../bridge/index.js';

declare global {
  interface Window {
    SceneBoardArtifact?: Readonly<{
      onHostMessage(listener: (message: ArtifactBridgeMessageV1, binary?: ArrayBuffer) => void): () => void;
      requestResize(width: number, height: number): void;
      changeSelection(nodeIds: string[]): void;
      userAction(requestId: string, capability: 'clipboard.write' | 'download' | 'fullscreen'): void;
      requestCapability(
        requestId: string,
        capability: 'clipboard.write' | 'download' | 'fullscreen' | 'network.fetch',
        payload: Record<string, unknown>,
        binary?: ArrayBuffer,
      ): void;
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

type BinaryCarrier = { envelope: ArtifactBridgeEnvelopeV1; binary: ArrayBuffer };

const hostListeners = new Set<(message: ArtifactBridgeMessageV1, binary?: ArrayBuffer) => void>();
const nativeGlobalThis = globalThis;
const nativeUrl = URL;
const nativeReflectApply = Reflect.apply;
const nativePortPostMessage = MessagePort.prototype.postMessage;
const nativePortStart = MessagePort.prototype.start;
const nativePortClose = MessagePort.prototype.close;
const nativePortOnMessageSetter = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')?.set;
const nativeStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
const nativePerformanceNow = Performance.prototype.now;
const nativePerformance = performance;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeRequestAnimationFrame = globalThis.requestAnimationFrame;
const nativeCancelAnimationFrame = globalThis.cancelAnimationFrame;
const nativeCreateObjectUrl = URL.createObjectURL;
const nativeRevokeObjectUrl = URL.revokeObjectURL;
const nativeElementRemove = Element.prototype.remove;
const nativeMessageEventDataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
const nativeMessageEventPortsGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports')?.get;
const nativeObjectKeys = Object.keys;
const nativeObjectHasOwn = Object.hasOwn;
const nativeArrayIsArray = Array.isArray;
const nativeNumberIsInteger = Number.isInteger;
const nativeMathMax = Math.max;
const nativeMathMin = Math.min;
const nativeEventCancelableGetter = Object.getOwnPropertyDescriptor(Event.prototype, 'cancelable')?.get;
const nativeEventPreventDefault = Event.prototype.preventDefault;
const nativeMouseEventButtonGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'button')?.get;
const nativeMouseEventButtonsGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'buttons')?.get;
const nativeMouseEventClientXGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'clientX')?.get;
const nativeMouseEventClientYGetter = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'clientY')?.get;
const nativePointerEventPointerIdGetter = Object.getOwnPropertyDescriptor(PointerEvent.prototype, 'pointerId')?.get;
const nativeWheelEventDeltaYGetter = Object.getOwnPropertyDescriptor(WheelEvent.prototype, 'deltaY')?.get;
const nativeWheelEventDeltaModeGetter = Object.getOwnPropertyDescriptor(WheelEvent.prototype, 'deltaMode')?.get;
const nativeDocumentHiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get;
const nativeWindowInnerWidthGetter = Object.getOwnPropertyDescriptor(window, 'innerWidth')?.get;
const nativeWindowInnerHeightGetter = Object.getOwnPropertyDescriptor(window, 'innerHeight')?.get;
const nativeElementSetPointerCapture = Element.prototype.setPointerCapture;
const nativeElementHasPointerCapture = Element.prototype.hasPointerCapture;
const nativeElementReleasePointerCapture = Element.prototype.releasePointerCapture;
const nativeDocumentElement = document.documentElement;
const nativeArrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
if (nativeEventCancelableGetter === undefined
  || nativeMouseEventButtonGetter === undefined
  || nativeMouseEventButtonsGetter === undefined
  || nativeMouseEventClientXGetter === undefined
  || nativeMouseEventClientYGetter === undefined
  || nativePointerEventPointerIdGetter === undefined
  || nativeWheelEventDeltaYGetter === undefined
  || nativeWheelEventDeltaModeGetter === undefined
  || nativeDocumentHiddenGetter === undefined
  || nativeWindowInnerWidthGetter === undefined
  || nativeWindowInnerHeightGetter === undefined) throw new TypeError('trusted navigation primitives are unavailable');
let port: MessagePort | null = null;
let outboundIdentity: Readonly<Pick<ArtifactBridgeEnvelopeV1, 'channelId' | 'sessionId' | 'artifact'>> | null = null;
let outboundSequence = 1;
let inboundSequence = 2;
let scriptUrl: string | null = null;
let scriptElement: HTMLScriptElement | null = null;
let firstMeasureFrame: number | null = null;
let secondMeasureFrame: number | null = null;
let disposed = false;
let navigationEnabled = false;
let activePointer: { id: number; x: number; y: number } | null = null;

const send = (message: ArtifactBridgeMessageV1, binary?: ArrayBuffer): void => {
  if (disposed) return;
  const activePort = port;
  const identity = outboundIdentity;
  if (identity === null || activePort === null) return;
  const envelope: ArtifactBridgeEnvelopeV1 = {
    protocolVersion: 1,
    type: 'artifact.bridge',
    channelId: identity.channelId,
    sessionId: identity.sessionId,
    artifact: identity.artifact,
    sequence: outboundSequence,
    message,
  };
  outboundSequence += 1;
  const outgoing = binary === undefined ? envelope : { envelope, binary };
  nativeReflectApply(nativePortPostMessage, activePort, [outgoing, binary === undefined ? [] : [binary]]);
};

const navigation = new ArtifactNavigationSchedulerV1({
  now: () => nativeReflectApply(nativePerformanceNow, nativePerformance, []),
  schedule: (callback, delayMs) => nativeReflectApply(nativeSetTimeout, nativeGlobalThis, [callback, delayMs]),
  cancel: (handle) => nativeReflectApply(nativeClearTimeout, nativeGlobalThis, [handle as ReturnType<typeof setTimeout>]),
  emit: (message) => send(message),
});

const pointerAnchor = (clientX: number, clientY: number): { xMillionth: number; yMillionth: number } => ({
  ...artifactPointerAnchorV1(
    clientX,
    clientY,
    nativeReflectApply(nativeWindowInnerWidthGetter, window, []) as number,
    nativeReflectApply(nativeWindowInnerHeightGetter, window, []) as number,
  ),
});

const eventCancelable = (event: Event): boolean => nativeReflectApply(nativeEventCancelableGetter, event, []) as boolean;
const preventEventDefault = (event: Event): void => nativeReflectApply(nativeEventPreventDefault, event, []);
const mouseButton = (event: MouseEvent): number => nativeReflectApply(nativeMouseEventButtonGetter, event, []) as number;
const mouseButtons = (event: MouseEvent): number => nativeReflectApply(nativeMouseEventButtonsGetter, event, []) as number;
const mouseClientX = (event: MouseEvent): number => nativeReflectApply(nativeMouseEventClientXGetter, event, []) as number;
const mouseClientY = (event: MouseEvent): number => nativeReflectApply(nativeMouseEventClientYGetter, event, []) as number;
const pointerId = (event: PointerEvent): number => nativeReflectApply(nativePointerEventPointerIdGetter, event, []) as number;

const cancelPan = (): void => {
  const pointer = activePointer;
  activePointer = null;
  if (pointer === null) return;
  navigation.cancelPan(pointer.id);
  try {
    if (nativeReflectApply(nativeElementHasPointerCapture, nativeDocumentElement, [pointer.id])) {
      nativeReflectApply(nativeElementReleasePointerCapture, nativeDocumentElement, [pointer.id]);
    }
  } catch {}
};

const setNavigationEnabled = (enabled: boolean): void => {
  navigationEnabled = enabled;
  if (!enabled) cancelPan();
  navigation.setEnabled(enabled);
};

window.addEventListener('wheel', (event) => {
  if (!navigationEnabled || !event.isTrusted) return;
  const deltaY = normalizeArtifactWheelDeltaV1(
    nativeReflectApply(nativeWheelEventDeltaYGetter, event, []) as number,
    nativeReflectApply(nativeWheelEventDeltaModeGetter, event, []) as number,
    nativeReflectApply(nativeWindowInnerHeightGetter, window, []) as number,
  );
  if (deltaY === null) return;
  if (eventCancelable(event)) preventEventDefault(event);
  navigation.wheel({ type: 'artifact.navigation.wheel', ...pointerAnchor(mouseClientX(event), mouseClientY(event)), deltaY });
}, { capture: true, passive: false });

window.addEventListener('pointerdown', (event) => {
  const id = pointerId(event);
  const clientX = mouseClientX(event);
  const clientY = mouseClientY(event);
  if (!navigationEnabled || !event.isTrusted || mouseButton(event) !== 1 || (mouseButtons(event) & 4) === 0 || activePointer !== null || navigation.hasPan || !nativeNumberIsInteger(id) || id < 0 || id > 2_147_483_647) return;
  if (eventCancelable(event)) preventEventDefault(event);
  activePointer = { id, x: clientX, y: clientY };
  try { nativeReflectApply(nativeElementSetPointerCapture, nativeDocumentElement, [id]); } catch { activePointer = null; return; }
  if (!navigation.start({ type: 'artifact.navigation.pan.start', pointerId: id, ...pointerAnchor(clientX, clientY) })) activePointer = null;
}, { capture: true, passive: false });

window.addEventListener('pointermove', (event) => {
  const pointer = activePointer;
  if (!navigationEnabled || pointer === null || !event.isTrusted || pointerId(event) !== pointer.id) return;
  if ((mouseButtons(event) & 4) === 0) return cancelPan();
  const clientX = mouseClientX(event);
  const clientY = mouseClientY(event);
  const deltaX = nativeMathMax(-16_384, nativeMathMin(16_384, clientX - pointer.x));
  const deltaY = nativeMathMax(-16_384, nativeMathMin(16_384, clientY - pointer.y));
  pointer.x = clientX;
  pointer.y = clientY;
  if (deltaX === 0 && deltaY === 0) return;
  if (eventCancelable(event)) preventEventDefault(event);
  navigation.move(pointer.id, deltaX, deltaY);
}, { capture: true, passive: false });

window.addEventListener('pointerup', (event) => {
  const pointer = activePointer;
  if (pointer === null || !event.isTrusted || pointerId(event) !== pointer.id || mouseButton(event) !== 1) return;
  if (eventCancelable(event)) preventEventDefault(event);
  activePointer = null;
  try {
    if (nativeReflectApply(nativeElementHasPointerCapture, nativeDocumentElement, [pointer.id])) {
      nativeReflectApply(nativeElementReleasePointerCapture, nativeDocumentElement, [pointer.id]);
    }
  } catch {
    navigation.cancelPan(pointer.id);
    return;
  }
  navigation.end(
    pointer.id,
    nativeMathMax(-16_384, nativeMathMin(16_384, mouseClientX(event) - pointer.x)),
    nativeMathMax(-16_384, nativeMathMin(16_384, mouseClientY(event) - pointer.y)),
  );
}, { capture: true, passive: false });

window.addEventListener('pointercancel', (event) => { if (event.isTrusted && activePointer?.id === pointerId(event)) cancelPan(); }, { capture: true });
nativeDocumentElement.addEventListener('lostpointercapture', (event) => { if (event.isTrusted && activePointer?.id === pointerId(event)) cancelPan(); }, { capture: true });
window.addEventListener('blur', (event) => { if (event.isTrusted) cancelPan(); });
document.addEventListener('visibilitychange', () => { if (nativeReflectApply(nativeDocumentHiddenGetter, document, [])) cancelPan(); });

const dispose = (): void => {
  if (disposed) return;
  if (outboundIdentity !== null && port !== null) {
    try { send({ type: 'peer.disposed' }); } catch { /* terminal */ }
  }
  disposed = true;
  if (port !== null) nativeReflectApply(nativePortClose, port, []);
  if (scriptElement !== null) nativeReflectApply(nativeElementRemove, scriptElement, []);
  scriptElement = null;
  if (scriptUrl !== null) nativeReflectApply(nativeRevokeObjectUrl, nativeUrl, [scriptUrl]);
  scriptUrl = null;
  if (firstMeasureFrame !== null) nativeReflectApply(nativeCancelAnimationFrame, nativeGlobalThis, [firstMeasureFrame]);
  if (secondMeasureFrame !== null) nativeReflectApply(nativeCancelAnimationFrame, nativeGlobalThis, [secondMeasureFrame]);
  navigation.dispose();
  activePointer = null;
  hostListeners.clear();
};

window.SceneBoardArtifact = Object.freeze({
  onHostMessage(listener: (message: ArtifactBridgeMessageV1, binary?: ArrayBuffer) => void): () => void {
    if (typeof listener !== 'function' || disposed) throw new TypeError('artifact host listener is invalid');
    hostListeners.add(listener);
    return () => hostListeners.delete(listener);
  },
  requestResize(width: number, height: number): void {
    send({ type: 'artifact.resize.request', value: { width, height, source: 'explicit' } });
  },
  changeSelection(nodeIds: string[]): void {
    send({ type: 'artifact.selection.change', value: { nodeIds } });
  },
  userAction(requestId: string, capability: 'clipboard.write' | 'download' | 'fullscreen'): void {
    send({ type: 'artifact.user-action', requestId, capability });
  },
  requestCapability(
    requestId: string,
    capability: 'clipboard.write' | 'download' | 'fullscreen' | 'network.fetch',
    payload: Record<string, unknown>,
    binary?: ArrayBuffer,
  ): void {
    if ((capability === 'download') !== (binary !== undefined)) throw new TypeError('download capability binary is invalid');
    send({ type: 'artifact.capability.request', requestId, capability, payload }, binary);
  },
});

const runArtifact = async (): Promise<void> => {
  const assertActive = (): void => {
    if (disposed) throw new TypeError('artifact inner run was disposed');
  };
  if (resources.css !== null) {
    const style = document.createElement('style');
    style.textContent = resources.css;
    document.head.append(style);
  }
  if (resources.diagram && window.mermaid !== undefined) {
    window.mermaid.initialize({ securityLevel: 'strict', startOnLoad: false });
    await window.mermaid.run({ querySelector: 'pre.mermaid' });
    assertActive();
  }
  if (resources.javascript !== null) {
    scriptUrl = nativeReflectApply(nativeCreateObjectUrl, nativeUrl, [new Blob([resources.javascript], { type: 'text/javascript' })]);
    assertActive();
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      scriptElement = script;
      script.src = scriptUrl as string;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new TypeError('artifact script failed')), { once: true });
      document.body.append(script);
    });
    assertActive();
    scriptElement = null;
  }
  firstMeasureFrame = nativeReflectApply(nativeRequestAnimationFrame, nativeGlobalThis, [() => {
    firstMeasureFrame = null;
    if (disposed) return;
    secondMeasureFrame = nativeReflectApply(nativeRequestAnimationFrame, nativeGlobalThis, [() => {
      secondMeasureFrame = null;
      if (disposed) return;
      const origin = document.body.getBoundingClientRect();
      const candidates = [...document.body.querySelectorAll<HTMLElement>('*')]
        .filter((element) => element.tagName !== 'SCRIPT' && element.tagName !== 'TEMPLATE');
      if (candidates.length === 0) {
        send({ type: 'artifact.resize.request', value: { width: 1_200, height: 675, source: 'observer' } });
        return;
      }
      const measured = measureArtifactContentSizeV1(origin, candidates.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
        };
      }));
      send({ type: 'artifact.resize.request', value: {
        ...measured,
        source: 'observer',
      } });
    }]);
  }]);
  send({ type: 'artifact.ready' });
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (nativeMessageEventDataGetter === undefined || nativeMessageEventPortsGetter === undefined || nativeArrayBufferByteLengthGetter === undefined) return;
  const eventPorts = nativeReflectApply(nativeMessageEventPortsGetter, event, []);
  if (outboundIdentity !== null || event.source !== window.parent || event.origin !== 'null' || eventPorts.length !== 1) return;
  nativeReflectApply(nativeStopImmediatePropagation, event, []);
  const eventData = nativeReflectApply(nativeMessageEventDataGetter, event, []);
  const parsed = parseArtifactBridgeEnvelopeV1(eventData, { messagePorts: 1, arrayBufferBytes: [] });
  if (parsed.envelope.message.type !== 'host.inner.init') return;
  outboundIdentity = Object.freeze({
    channelId: parsed.envelope.channelId,
    sessionId: parsed.envelope.sessionId,
    artifact: Object.freeze({ ...parsed.envelope.artifact }),
  });
  port = eventPorts[0] ?? null;
  if (port === null) return;
  if (nativePortOnMessageSetter === undefined) throw new TypeError('artifact port listener is unavailable');
  nativeReflectApply(nativePortOnMessageSetter, port, [(innerEvent: MessageEvent<ArtifactBridgeEnvelopeV1 | BinaryCarrier>) => {
    const identity = outboundIdentity;
    if (identity === null) return;
    const innerEventData = nativeReflectApply(nativeMessageEventDataGetter, innerEvent, []);
    const innerEventPorts = nativeReflectApply(nativeMessageEventPortsGetter, innerEvent, []);
    let raw: unknown = innerEventData;
    let binary: ArrayBuffer | undefined;
    if (innerEventPorts.length !== 0) throw new TypeError('artifact host message ports are invalid');
    if (innerEventData !== null && typeof innerEventData === 'object' && !nativeArrayIsArray(innerEventData)
      && nativeObjectKeys(innerEventData).length === 2 && nativeObjectHasOwn(innerEventData, 'envelope') && nativeObjectHasOwn(innerEventData, 'binary')) {
      const carrier = innerEventData as BinaryCarrier;
      let binaryByteLength: number;
      try { binaryByteLength = nativeReflectApply(nativeArrayBufferByteLengthGetter, carrier.binary, []); } catch { throw new TypeError('binary carrier is invalid'); }
      raw = carrier.envelope;
      binary = carrier.binary;
      if (binaryByteLength < 0) throw new TypeError('binary carrier is invalid');
    }
    if (raw === null || typeof raw !== 'object' || nativeArrayIsArray(raw)) throw new TypeError('artifact bridge envelope is invalid');
    const envelope = raw as ArtifactBridgeEnvelopeV1;
    if (envelope.protocolVersion !== 1
      || envelope.type !== 'artifact.bridge'
      || envelope.channelId !== identity.channelId
      || envelope.sessionId !== identity.sessionId
      || envelope.artifact?.artifactId !== identity.artifact.artifactId
      || envelope.artifact?.versionId !== identity.artifact.versionId
      || envelope.sequence !== inboundSequence
      || envelope.message === null
      || typeof envelope.message !== 'object') throw new TypeError('artifact bridge envelope is invalid');
    inboundSequence += 1;
    const incoming = envelope.message;
    if (incoming.type !== 'host.dispose'
      && incoming.type !== 'host.watchdog.ping'
      && incoming.type !== 'host.navigation.set'
      && incoming.type !== 'host.theme'
      && incoming.type !== 'host.data'
      && incoming.type !== 'host.viewport'
      && incoming.type !== 'host.selection'
      && incoming.type !== 'host.capability.result') throw new TypeError('artifact host message is invalid');
    if (incoming.type === 'host.dispose') {
      dispose();
      return;
    }
    if (incoming.type === 'host.watchdog.ping') {
      send({ type: 'runner.watchdog.pong', watchdogId: incoming.watchdogId, sentAtMonotonicMs: incoming.sentAtMonotonicMs });
      return;
    }
    if (incoming.type === 'host.navigation.set') {
      setNavigationEnabled(incoming.enabled);
      return;
    }
    for (const listener of hostListeners) listener(incoming, binary);
  }]);
  nativeReflectApply(nativePortStart, port, []);
  void runArtifact().catch(() => dispose());
}, { once: true });
