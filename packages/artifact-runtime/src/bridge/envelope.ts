import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  ArtifactReferenceParserV1,
  GlobalIdStringParserV1,
  canonicalizeJsonV1,
  type ArtifactReferenceV1,
  type ArtifactRequestCapabilityV1,
  type JsonValue,
} from '@sceneboard/board-schema';

export type Base64Url22 = string;

export type ArtifactNavigationControlV1 = Readonly<{
  type: 'host.navigation.set';
  enabled: boolean;
}>;
export type ArtifactNavigationIntentV1 =
  | Readonly<{
      type: 'artifact.navigation.wheel';
      xMillionth: number;
      yMillionth: number;
      deltaY: number;
    }>
  | Readonly<{
      type: 'artifact.navigation.pan.start';
      pointerId: number;
      xMillionth: number;
      yMillionth: number;
    }>
  | Readonly<{
      type: 'artifact.navigation.pan.move';
      pointerId: number;
      deltaX: number;
      deltaY: number;
    }>
  | Readonly<{
      type: 'artifact.navigation.pan.end';
      pointerId: number;
      deltaX: number;
      deltaY: number;
    }>
  | Readonly<{ type: 'artifact.navigation.pan.cancel'; pointerId: number }>;
export type ArtifactResizeRequestV1 = Readonly<{
  width: number;
  height: number;
  source: 'explicit' | 'observer';
  renderMode?: 'responsive-fixed-canvas';
}>;
export type ArtifactPresentationPageChangeV1 = Readonly<{
  pageId: string;
  pageIndex: number;
  pageCount: number;
}>;

export type ArtifactBridgeMessageV1 =
  | { type: 'host.bootstrap'; appOrigin: string; runtimeOrigin: string; policyEpoch: Base64Url22 }
  | { type: 'runner.ready'; supportedProtocolVersions: [1] }
  | {
      type: 'host.package.start';
      transferId: Base64Url22;
      totalBytes: number;
      chunkBytes: 262_144;
      chunkCount: number;
      manifestSha256: string;
      packageSha256: string;
    }
  | {
      type: 'host.package.chunk';
      transferId: Base64Url22;
      index: number;
      offset: number;
      byteLength: number;
    }
  | { type: 'runner.package.ack'; transferId: Base64Url22; index: number; receivedBytes: number }
  | {
      type: 'host.package.end';
      transferId: Base64Url22;
      chunkCount: number;
      totalBytes: number;
      packageSha256: string;
    }
  | { type: 'runner.package.ready'; transferId: Base64Url22; packageSha256: string }
  | { type: 'host.watchdog.ping'; watchdogId: Base64Url22; sentAtMonotonicMs: number }
  | { type: 'runner.watchdog.pong'; watchdogId: Base64Url22; sentAtMonotonicMs: number }
  | {
      type: 'host.inner.init';
      policyEpoch: Base64Url22;
      requestedCapabilities: ArtifactRequestCapabilityV1[];
    }
  | { type: 'artifact.ready' }
  | {
      type: 'host.theme';
      value: {
        colorScheme: 'light' | 'dark';
        foreground: string;
        background: string;
        accent: string;
        muted: string;
      };
    }
  | { type: 'host.data'; revisionId: string; projectionId: string; value: JsonValue }
  | { type: 'host.viewport'; value: { width: number; height: number; devicePixelRatio: number } }
  | { type: 'host.selection'; value: { nodeIds: string[] } }
  | { type: 'host.presentation'; active: boolean }
  | ArtifactNavigationControlV1
  | ArtifactNavigationIntentV1
  | { type: 'artifact.resize.request'; value: ArtifactResizeRequestV1 }
  | { type: 'artifact.presentation.page-change'; value: ArtifactPresentationPageChangeV1 }
  | { type: 'artifact.selection.change'; value: { nodeIds: string[] } }
  | {
      type: 'artifact.user-action';
      requestId: Base64Url22;
      capability: 'clipboard.write' | 'download' | 'fullscreen';
    }
  | {
      type: 'artifact.capability.request';
      requestId: Base64Url22;
      capability: ArtifactRequestCapabilityV1;
      payload: Record<string, unknown>;
    }
  | {
      type: 'host.capability.result';
      requestId: Base64Url22;
      capability: ArtifactRequestCapabilityV1;
      ok: boolean;
      result?: Record<string, unknown>;
      error?:
        | 'not_requested'
        | 'policy_denied'
        | 'activation_required'
        | 'activation_expired'
        | 'invalid_request'
        | 'revoked'
        | 'timeout'
        | 'unavailable';
    }
  | {
      type: 'host.dispose';
      reason:
        | 'unmount'
        | 'route_change'
        | 'logout'
        | 'policy_change'
        | 'status_change'
        | 'user_stop'
        | 'timeout'
        | 'protocol_error';
    }
  | { type: 'peer.disposed' }
  | {
      type: 'protocol.error';
      code:
        | 'schema'
        | 'source'
        | 'origin'
        | 'pair'
        | 'session'
        | 'sequence'
        | 'state'
        | 'size'
        | 'rate'
        | 'transfer'
        | 'timeout';
      correlationId: Base64Url22;
    };

export type ArtifactBridgeEnvelopeV1 = {
  protocolVersion: 1;
  type: 'artifact.bridge';
  channelId: Base64Url22;
  sessionId: Base64Url22;
  artifact: ArtifactReferenceV1;
  sequence: number;
  message: ArtifactBridgeMessageV1;
};

export type ArtifactBridgeTransfersV1 = {
  messagePorts: number;
  arrayBufferBytes: readonly number[];
};

export type ParsedArtifactBridgeEnvelopeV1 = {
  envelope: ArtifactBridgeEnvelopeV1;
  canonicalControlBytes: number;
};

const ID_22 = /^[A-Za-z0-9_-]{22}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const COLOR = /^#[0-9a-f]{6}$/u;
const PRESENTATION_PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVELOPE_KEYS = [
  'protocolVersion',
  'type',
  'channelId',
  'sessionId',
  'artifact',
  'sequence',
  'message',
] as const;

const MESSAGE_KEYS: Readonly<Record<ArtifactBridgeMessageV1['type'], readonly string[]>> =
  Object.freeze({
    'host.bootstrap': ['type', 'appOrigin', 'runtimeOrigin', 'policyEpoch'],
    'runner.ready': ['type', 'supportedProtocolVersions'],
    'host.package.start': [
      'type',
      'transferId',
      'totalBytes',
      'chunkBytes',
      'chunkCount',
      'manifestSha256',
      'packageSha256',
    ],
    'host.package.chunk': ['type', 'transferId', 'index', 'offset', 'byteLength'],
    'runner.package.ack': ['type', 'transferId', 'index', 'receivedBytes'],
    'host.package.end': ['type', 'transferId', 'chunkCount', 'totalBytes', 'packageSha256'],
    'runner.package.ready': ['type', 'transferId', 'packageSha256'],
    'host.watchdog.ping': ['type', 'watchdogId', 'sentAtMonotonicMs'],
    'runner.watchdog.pong': ['type', 'watchdogId', 'sentAtMonotonicMs'],
    'host.inner.init': ['type', 'policyEpoch', 'requestedCapabilities'],
    'artifact.ready': ['type'],
    'host.theme': ['type', 'value'],
    'host.data': ['type', 'revisionId', 'projectionId', 'value'],
    'host.viewport': ['type', 'value'],
    'host.selection': ['type', 'value'],
    'host.presentation': ['type', 'active'],
    'host.navigation.set': ['type', 'enabled'],
    'artifact.navigation.wheel': ['type', 'xMillionth', 'yMillionth', 'deltaY'],
    'artifact.navigation.pan.start': ['type', 'pointerId', 'xMillionth', 'yMillionth'],
    'artifact.navigation.pan.move': ['type', 'pointerId', 'deltaX', 'deltaY'],
    'artifact.navigation.pan.end': ['type', 'pointerId', 'deltaX', 'deltaY'],
    'artifact.navigation.pan.cancel': ['type', 'pointerId'],
    'artifact.resize.request': ['type', 'value'],
    'artifact.presentation.page-change': ['type', 'value'],
    'artifact.selection.change': ['type', 'value'],
    'artifact.user-action': ['type', 'requestId', 'capability'],
    'artifact.capability.request': ['type', 'requestId', 'capability', 'payload'],
    'host.capability.result': ['type', 'requestId', 'capability', 'ok', 'result', 'error'],
    'host.dispose': ['type', 'reason'],
    'peer.disposed': ['type'],
    'protocol.error': ['type', 'code', 'correlationId'],
  });

const CONTROL_CAPS: Readonly<Record<ArtifactBridgeMessageV1['type'], number>> = Object.freeze({
  'host.bootstrap': 2_048,
  'runner.ready': 2_048,
  'host.package.start': 2_048,
  'host.package.chunk': 1_024,
  'runner.package.ack': 2_048,
  'host.package.end': 2_048,
  'runner.package.ready': 2_048,
  'host.watchdog.ping': 1_024,
  'runner.watchdog.pong': 1_024,
  'host.inner.init': 2_048,
  'artifact.ready': 1_024,
  'host.theme': 2_048,
  'host.data': 65_536,
  'host.viewport': 1_024,
  'host.selection': 8_192,
  'host.presentation': 1_024,
  'host.navigation.set': 1_024,
  'artifact.navigation.wheel': 1_024,
  'artifact.navigation.pan.start': 1_024,
  'artifact.navigation.pan.move': 1_024,
  'artifact.navigation.pan.end': 1_024,
  'artifact.navigation.pan.cancel': 1_024,
  'artifact.resize.request': 1_024,
  'artifact.presentation.page-change': 1_024,
  'artifact.selection.change': 8_192,
  'artifact.user-action': 1_024,
  'artifact.capability.request': 67_584,
  'host.capability.result': 4_096,
  'host.dispose': 1_024,
  'peer.disposed': 1_024,
  'protocol.error': 1_024,
});

const exactKeys = (
  input: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(input);
  const required = allowed.filter((key) => !optional.includes(key));
  return (
    required.every((key) => Object.hasOwn(input, key)) &&
    keys.every((key) => allowed.includes(key)) &&
    keys.length >= required.length
  );
};

const record = (input: unknown, label: string): Record<string, unknown> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError(`${label} must be an object`);
  return input as Record<string, unknown>;
};

const safePlainData = (input: unknown): void => {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new Set<object>();
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const value = current.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('bridge data contains a non-finite number');
      continue;
    }
    if (typeof value !== 'object' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      throw new TypeError('bridge data contains a forbidden value');
    }
    if (seen.has(value)) throw new TypeError('bridge data contains a cycle');
    seen.add(value);
    if (current.depth > 12) throw new TypeError('bridge data is too deep');
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('bridge arrays must not be sparse');
        entries += 1;
        stack.push({ value: value[index], depth: current.depth + 1 });
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('bridge objects must be plain');
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new TypeError('bridge object keys must be strings');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          throw new TypeError('bridge objects must not have accessors');
        }
        entries += 1;
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
    if (entries > 20_000) throw new TypeError('bridge data has too many entries');
  }
};

const integer = (value: unknown, minimum: number, maximum: number, label: string): number => {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
};

const finite = (value: unknown, minimum: number, maximum: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new TypeError(`${label} is invalid`);
  return value;
};

const id22 = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !ID_22.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
};

const digest = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !HEX_64.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
};

const capabilities = (value: unknown): ArtifactRequestCapabilityV1[] => {
  if (!Array.isArray(value) || value.length > ARTIFACT_REQUEST_CAPABILITIES_V1.length) {
    throw new TypeError('requested capabilities are invalid');
  }
  const result = value as ArtifactRequestCapabilityV1[];
  for (let index = 0; index < result.length; index += 1) {
    if (
      !ARTIFACT_REQUEST_CAPABILITIES_V1.includes(result[index] as ArtifactRequestCapabilityV1) ||
      (index > 0 && (result[index - 1] ?? '') >= (result[index] ?? ''))
    ) {
      throw new TypeError('requested capabilities must be sorted and unique');
    }
  }
  return result;
};

const canonicalOrigin = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('bridge origin is invalid');
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('bridge origin must be canonical');
  }
  return value;
};

const ids = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError('selection is invalid');
  const result = value as unknown[];
  const strings: string[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const item = result[index];
    if (
      typeof item !== 'string' ||
      !GlobalIdStringParserV1.parse(item).ok ||
      (index > 0 && (strings[index - 1] ?? '') >= item)
    )
      throw new TypeError('selection must be sorted and unique');
    strings.push(item);
  }
  return strings;
};

const validateMessage = (message: Record<string, unknown>): ArtifactBridgeMessageV1 => {
  if (typeof message.type !== 'string' || !Object.hasOwn(MESSAGE_KEYS, message.type)) {
    throw new TypeError('bridge message type is unknown');
  }
  const type = message.type as ArtifactBridgeMessageV1['type'];
  const optional = type === 'host.capability.result' ? ['result', 'error'] : [];
  if (!exactKeys(message, MESSAGE_KEYS[type], optional))
    throw new TypeError('bridge message keys are invalid');
  switch (type) {
    case 'host.bootstrap':
      canonicalOrigin(message.appOrigin);
      canonicalOrigin(message.runtimeOrigin);
      id22(message.policyEpoch, 'policy epoch');
      break;
    case 'runner.ready':
      if (
        !Array.isArray(message.supportedProtocolVersions) ||
        message.supportedProtocolVersions.length !== 1 ||
        message.supportedProtocolVersions[0] !== 1
      )
        throw new TypeError('supported versions are invalid');
      break;
    case 'host.package.start':
      id22(message.transferId, 'transfer ID');
      integer(message.totalBytes, 1, 10_747_904, 'package bytes');
      if (message.chunkBytes !== 262_144) throw new TypeError('package chunk size is invalid');
      integer(message.chunkCount, 1, 65_535, 'package chunk count');
      digest(message.manifestSha256, 'manifest digest');
      digest(message.packageSha256, 'package digest');
      break;
    case 'host.package.chunk':
      id22(message.transferId, 'transfer ID');
      integer(message.index, 0, 65_534, 'chunk index');
      integer(message.offset, 0, 10_747_903, 'chunk offset');
      integer(message.byteLength, 1, 262_144, 'chunk length');
      break;
    case 'runner.package.ack':
      id22(message.transferId, 'transfer ID');
      integer(message.index, 0, 65_534, 'chunk index');
      integer(message.receivedBytes, 1, 10_747_904, 'received bytes');
      break;
    case 'host.package.end':
      id22(message.transferId, 'transfer ID');
      integer(message.chunkCount, 1, 65_535, 'chunk count');
      integer(message.totalBytes, 1, 10_747_904, 'package bytes');
      digest(message.packageSha256, 'package digest');
      break;
    case 'runner.package.ready':
      id22(message.transferId, 'transfer ID');
      digest(message.packageSha256, 'package digest');
      break;
    case 'host.watchdog.ping':
    case 'runner.watchdog.pong':
      id22(message.watchdogId, 'watchdog ID');
      if (
        typeof message.sentAtMonotonicMs !== 'number' ||
        !Number.isFinite(message.sentAtMonotonicMs) ||
        message.sentAtMonotonicMs < 0
      )
        throw new TypeError('watchdog time is invalid');
      break;
    case 'host.inner.init':
      id22(message.policyEpoch, 'policy epoch');
      capabilities(message.requestedCapabilities);
      break;
    case 'artifact.ready':
    case 'peer.disposed':
      break;
    case 'host.theme': {
      const value = record(message.value, 'theme');
      if (
        !exactKeys(value, ['colorScheme', 'foreground', 'background', 'accent', 'muted']) ||
        (value.colorScheme !== 'light' && value.colorScheme !== 'dark') ||
        [value.foreground, value.background, value.accent, value.muted].some(
          (item) => typeof item !== 'string' || !COLOR.test(item),
        )
      )
        throw new TypeError('theme is invalid');
      break;
    }
    case 'host.data':
      if (
        typeof message.revisionId !== 'string' ||
        !GlobalIdStringParserV1.parse(message.revisionId).ok ||
        typeof message.projectionId !== 'string' ||
        !GlobalIdStringParserV1.parse(message.projectionId).ok
      )
        throw new TypeError('host data IDs are invalid');
      break;
    case 'host.viewport':
    case 'artifact.resize.request': {
      const value = record(message.value, 'viewport');
      const allowed =
        type === 'host.viewport'
          ? ['width', 'height', 'devicePixelRatio']
          : value.renderMode === undefined
            ? ['width', 'height', 'source']
            : ['width', 'height', 'source', 'renderMode'];
      if (!exactKeys(value, allowed)) throw new TypeError('viewport keys are invalid');
      integer(value.width, 1, 16_384, 'width');
      integer(value.height, 1, 16_384, 'height');
      if (
        type === 'host.viewport' &&
        (typeof value.devicePixelRatio !== 'number' ||
          !Number.isFinite(value.devicePixelRatio) ||
          value.devicePixelRatio <= 0 ||
          value.devicePixelRatio > 4)
      )
        throw new TypeError('device pixel ratio is invalid');
      if (
        type === 'artifact.resize.request' &&
        value.source !== 'explicit' &&
        value.source !== 'observer'
      )
        throw new TypeError('resize source is invalid');
      if (
        type === 'artifact.resize.request' &&
        value.renderMode !== undefined &&
        value.renderMode !== 'responsive-fixed-canvas'
      )
        throw new TypeError('resize render mode is invalid');
      break;
    }
    case 'host.selection':
    case 'artifact.selection.change': {
      const value = record(message.value, 'selection');
      if (!exactKeys(value, ['nodeIds'])) throw new TypeError('selection keys are invalid');
      ids(value.nodeIds);
      break;
    }
    case 'artifact.presentation.page-change': {
      const value = record(message.value, 'presentation page');
      if (!exactKeys(value, ['pageId', 'pageIndex', 'pageCount']))
        throw new TypeError('presentation page keys are invalid');
      if (typeof value.pageId !== 'string' || !PRESENTATION_PAGE_ID.test(value.pageId))
        throw new TypeError('presentation page ID is invalid');
      const pageIndex = integer(value.pageIndex, 0, 999, 'presentation page index');
      const pageCount = integer(value.pageCount, 1, 1_000, 'presentation page count');
      if (pageIndex >= pageCount) throw new TypeError('presentation page range is invalid');
      break;
    }
    case 'host.navigation.set':
      if (typeof message.enabled !== 'boolean')
        throw new TypeError('navigation control is invalid');
      break;
    case 'host.presentation':
      if (typeof message.active !== 'boolean')
        throw new TypeError('presentation control is invalid');
      break;
    case 'artifact.navigation.wheel':
      integer(message.xMillionth, 0, 1_000_000, 'navigation x');
      integer(message.yMillionth, 0, 1_000_000, 'navigation y');
      if (finite(message.deltaY, -16_384, 16_384, 'wheel delta') === 0)
        throw new TypeError('wheel delta is invalid');
      break;
    case 'artifact.navigation.pan.start':
      integer(message.pointerId, 0, 2_147_483_647, 'pointer ID');
      integer(message.xMillionth, 0, 1_000_000, 'navigation x');
      integer(message.yMillionth, 0, 1_000_000, 'navigation y');
      break;
    case 'artifact.navigation.pan.move':
    case 'artifact.navigation.pan.end':
      integer(message.pointerId, 0, 2_147_483_647, 'pointer ID');
      finite(message.deltaX, -16_384, 16_384, 'pan x');
      finite(message.deltaY, -16_384, 16_384, 'pan y');
      break;
    case 'artifact.navigation.pan.cancel':
      integer(message.pointerId, 0, 2_147_483_647, 'pointer ID');
      break;
    case 'artifact.user-action':
      id22(message.requestId, 'request ID');
      if (!['clipboard.write', 'download', 'fullscreen'].includes(String(message.capability)))
        throw new TypeError('user action capability is invalid');
      break;
    case 'artifact.capability.request':
      id22(message.requestId, 'request ID');
      if (
        !ARTIFACT_REQUEST_CAPABILITIES_V1.includes(
          message.capability as ArtifactRequestCapabilityV1,
        )
      )
        throw new TypeError('capability is invalid');
      record(message.payload, 'capability payload');
      break;
    case 'host.capability.result':
      id22(message.requestId, 'request ID');
      if (
        !ARTIFACT_REQUEST_CAPABILITIES_V1.includes(
          message.capability as ArtifactRequestCapabilityV1,
        ) ||
        typeof message.ok !== 'boolean'
      )
        throw new TypeError('capability result is invalid');
      if (
        message.ok
          ? !Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')
          : !Object.hasOwn(message, 'error') || Object.hasOwn(message, 'result')
      )
        throw new TypeError('capability result branch is invalid');
      break;
    case 'host.dispose':
      if (
        ![
          'unmount',
          'route_change',
          'logout',
          'policy_change',
          'status_change',
          'user_stop',
          'timeout',
          'protocol_error',
        ].includes(String(message.reason))
      )
        throw new TypeError('dispose reason is invalid');
      break;
    case 'protocol.error':
      id22(message.correlationId, 'correlation ID');
      if (
        ![
          'schema',
          'source',
          'origin',
          'pair',
          'session',
          'sequence',
          'state',
          'size',
          'rate',
          'transfer',
          'timeout',
        ].includes(String(message.code))
      )
        throw new TypeError('protocol error code is invalid');
      break;
  }
  return message as ArtifactBridgeMessageV1;
};

const validateTransfers = (
  message: ArtifactBridgeMessageV1,
  transfers: ArtifactBridgeTransfersV1,
): void => {
  if (
    !Number.isInteger(transfers.messagePorts) ||
    transfers.messagePorts < 0 ||
    transfers.arrayBufferBytes.some((value) => !Number.isInteger(value) || value < 0)
  )
    throw new TypeError('bridge transfer metadata is invalid');
  const portCount = message.type === 'host.bootstrap' || message.type === 'host.inner.init' ? 1 : 0;
  let arrayBufferBytes: readonly number[] = [];
  if (message.type === 'host.package.chunk') arrayBufferBytes = [message.byteLength];
  if (message.type === 'artifact.capability.request' && message.capability === 'download') {
    const payload = record(message.payload, 'download payload');
    arrayBufferBytes = [integer(payload.byteLength, 0, 1_048_576, 'download bytes')];
  }
  if (
    message.type === 'host.capability.result' &&
    message.ok &&
    message.capability === 'network.fetch'
  ) {
    const result = record(message.result, 'network result');
    arrayBufferBytes = [integer(result.byteLength, 0, 1_048_576, 'network bytes')];
  }
  if (
    transfers.messagePorts !== portCount ||
    transfers.arrayBufferBytes.length !== arrayBufferBytes.length ||
    arrayBufferBytes.some((value, index) => transfers.arrayBufferBytes[index] !== value)
  ) {
    throw new TypeError('bridge transfer list does not match the message');
  }
};

export const parseArtifactBridgeEnvelopeV1 = (
  input: unknown,
  transfers: ArtifactBridgeTransfersV1 = { messagePorts: 0, arrayBufferBytes: [] },
): ParsedArtifactBridgeEnvelopeV1 => {
  safePlainData(input);
  const source = record(input, 'bridge envelope');
  if (
    !exactKeys(source, ENVELOPE_KEYS) ||
    source.protocolVersion !== 1 ||
    source.type !== 'artifact.bridge'
  )
    throw new TypeError('bridge envelope keys are invalid');
  const channelId = id22(source.channelId, 'channel ID');
  const sessionId = id22(source.sessionId, 'session ID');
  const artifact = ArtifactReferenceParserV1.parse(source.artifact);
  if (!artifact.ok) throw new TypeError('bridge artifact pair is invalid');
  const sequence = integer(source.sequence, 1, Number.MAX_SAFE_INTEGER, 'bridge sequence');
  const message = validateMessage(record(source.message, 'bridge message'));
  validateTransfers(message, transfers);
  const canonical = canonicalizeJsonV1(source);
  if (!canonical.ok) throw new TypeError('bridge envelope is not canonicalizable');
  const controlBytes = canonical.data.canonicalBytes.byteLength;
  if (controlBytes > CONTROL_CAPS[message.type])
    throw new TypeError('bridge control message exceeds its cap');
  return {
    envelope: {
      protocolVersion: 1,
      type: 'artifact.bridge',
      channelId,
      sessionId,
      artifact: artifact.data.value,
      sequence,
      message,
    },
    canonicalControlBytes: controlBytes,
  };
};

export const artifactBridgeControlCapV1 = (type: ArtifactBridgeMessageV1['type']): number =>
  CONTROL_CAPS[type];
