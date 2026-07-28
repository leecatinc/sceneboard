export const SUCCESS_BODY_LIMIT = 2_097_152;
export const ERROR_BODY_LIMIT = 65_536;
export const GLOBAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const LOCAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
export const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
export const PAIRING_CODE_PATTERN = /^(?:SB-)?[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/i;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
export const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const NODE_TYPES = [
  'layout.split',
  'layout.grid',
  'layout.tabs',
  'layout.canvas',
  'content.markdown',
  'content.code',
  'content.table',
  'content.chart',
  'content.map',
  'content.drawing',
  'content.status',
  'content.image',
  'content.progress',
  'content.hitl',
  'content.artifact',
];

export const COMMAND_TYPES = [
  'scene.replace',
  'scene.clear',
  'scene.restore',
  'hitl.request',
  'hitl.respond',
  'artifact.publish',
  'artifact.stop',
];

export const OPERATION_TYPES = [
  'board.list',
  'board.get',
  'board.create',
  'board.archive',
  'capabilities.get',
  'history.list',
  'history.get',
  'artifact.get',
  'hitl.read',
];

export const EVENT_TYPES = [
  'board.snapshot',
  'board.revision.created',
  'hitl.updated',
  'artifact.status.changed',
  'presence.updated',
  'stream.resync.required',
  'stream.heartbeat',
  'stream.error',
];

export const HITL_KINDS = ['info', 'choice', 'form', 'confirmation'];
export const CAPABILITY_SCOPES = [
  'artifact.control',
  'artifact.publish',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'board.media.write',
  'board.read',
  'board.write',
];
export const GRANT_SCOPES = [
  'board.read',
  'board.write',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'board.media.write',
  'artifact.publish',
  'artifact.control',
];
export const LIFECYCLE_PERMISSIONS = ['board.create', 'board.archive'];
export const ARTIFACT_CAPABILITIES = ['clipboard.write', 'download', 'fullscreen', 'network.fetch'];

export const BOARD_LIMITS = {
  maxEnvelopeBytes: 1_048_576,
  maxSceneBytes: 786_432,
  maxSceneDepth: 12,
  maxSceneNodes: 500,
  maxJsonDepth: 64,
  maxJsonContainerEntries: 10_000,
  maxSplitChildren: 12,
  maxGridColumns: 24,
  maxGridRows: 100,
  maxGridItems: 200,
  maxTabs: 20,
  maxCanvasItems: 200,
  maxCanvasExtent: 100_000,
  maxTitleChars: 200,
  maxImageAltChars: 500,
  maxMarkdownChars: 100_000,
  maxCodeChars: 200_000,
  maxTableColumns: 50,
  maxTableRows: 500,
  maxTableCells: 10_000,
  maxChartSeries: 32,
  maxChartPoints: 10_000,
  maxMapFeatures: 5_000,
  maxDrawingElements: 5_000,
  maxArtifactResources: 128,
  maxArtifactResourceBytes: 5_242_880,
  maxArtifactTotalBytes: 10_485_760,
  maxBoardArtifacts: 100,
  maxBoardArtifactVersions: 1_000,
  maxBoardArtifactResourceRows: 10_000,
  maxBoardArtifactChargedBytes: 536_870_912,
  maxHitlOptions: 50,
  maxHitlFields: 50,
  maxHitlTextChars: 60_000,
  maxHitlResponseBytes: 65_536,
  maxPageSize: 100,
  maxPageCursorChars: 512,
  maxHitlWaitMs: 30_000,
};

export const CONNECTION_VERSIONS = { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' };
export const PAIRING_STATES = ['pending', 'approved', 'redeemed', 'denied', 'cancelled', 'expired'];

export const PAIRING_ERROR_STATUS = {
  INVALID_PAYLOAD: 400,
  PAIRING_UNAVAILABLE: 400,
  PAIRING_PROOF_INVALID: 401,
  PAIRING_NOT_READY: 409,
  PAIRING_TERMINAL: 410,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};

export const BOARD_ERROR_STATUS = {
  INVALID_PAYLOAD: 400,
  PROTOCOL_VERSION_MISMATCH: 409,
  UNKNOWN_NODE_TYPE: 422,
  UNKNOWN_COMMAND_TYPE: 422,
  UNKNOWN_OPERATION_TYPE: 422,
  INVALID_LAYOUT: 422,
  DUPLICATE_NODE_ID: 422,
  LIMIT_EXCEEDED: 422,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CAPABILITY_DENIED: 403,
  BOARD_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  HITL_REQUEST_NOT_FOUND: 404,
  BOARD_ALREADY_ARCHIVED: 409,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  HITL_REQUEST_ID_CONFLICT: 409,
  HITL_RESPONSE_CONFLICT: 409,
  HITL_REQUEST_EXPIRED: 410,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export const RETRYABLE_BOARD_ERRORS = new Set(['RATE_LIMITED', 'SERVICE_UNAVAILABLE']);
export const BOARD_ERROR_CATEGORIES = {
  INVALID_PAYLOAD: 'validation',
  PROTOCOL_VERSION_MISMATCH: 'protocol',
  UNKNOWN_NODE_TYPE: 'validation',
  UNKNOWN_COMMAND_TYPE: 'validation',
  UNKNOWN_OPERATION_TYPE: 'validation',
  INVALID_LAYOUT: 'validation',
  DUPLICATE_NODE_ID: 'validation',
  LIMIT_EXCEEDED: 'validation',
  PAYLOAD_TOO_LARGE: 'validation',
  UNAUTHENTICATED: 'auth',
  FORBIDDEN: 'auth',
  CAPABILITY_DENIED: 'auth',
  BOARD_NOT_FOUND: 'not_found',
  REVISION_NOT_FOUND: 'not_found',
  ARTIFACT_NOT_FOUND: 'not_found',
  HITL_REQUEST_NOT_FOUND: 'not_found',
  BOARD_ALREADY_ARCHIVED: 'conflict',
  REVISION_CONFLICT: 'conflict',
  IDEMPOTENCY_KEY_REUSED: 'conflict',
  HITL_REQUEST_ID_CONFLICT: 'conflict',
  HITL_RESPONSE_CONFLICT: 'conflict',
  HITL_REQUEST_EXPIRED: 'conflict',
  RATE_LIMITED: 'rate_limit',
  SERVICE_UNAVAILABLE: 'availability',
  INTERNAL_ERROR: 'internal',
};

const COMMON_ERRORS = [
  'INVALID_PAYLOAD',
  'PROTOCOL_VERSION_MISMATCH',
  'UNAUTHENTICATED',
  'FORBIDDEN',
];
const AVAILABILITY_ERRORS = ['RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR'];

export const OPERATION_ERROR_CODES = {
  board_connection_status: [
    'INVALID_PAYLOAD',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    ...AVAILABILITY_ERRORS,
  ],
  board_list: [...COMMON_ERRORS, ...AVAILABILITY_ERRORS],
  board_get: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_create: [...COMMON_ERRORS, 'IDEMPOTENCY_KEY_REUSED', ...AVAILABILITY_ERRORS],
  board_archive: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'BOARD_ALREADY_ARCHIVED',
    'IDEMPOTENCY_KEY_REUSED',
    ...AVAILABILITY_ERRORS,
  ],
  board_capabilities_get: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_scene_get: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    ...AVAILABILITY_ERRORS,
  ],
  board_scene_replace: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    ...AVAILABILITY_ERRORS,
  ],
  board_scene_patch: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    ...AVAILABILITY_ERRORS,
  ],
  board_scene_clear: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    ...AVAILABILITY_ERRORS,
  ],
  board_artifact_get: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'ARTIFACT_NOT_FOUND',
    ...AVAILABILITY_ERRORS,
  ],
  board_artifact_put: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'CAPABILITY_DENIED',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    ...AVAILABILITY_ERRORS,
  ],
  board_artifact_stop: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'ARTIFACT_NOT_FOUND',
    ...AVAILABILITY_ERRORS,
  ],
  board_history_list: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_history_get: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    ...AVAILABILITY_ERRORS,
  ],
  board_history_restore: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    ...AVAILABILITY_ERRORS,
  ],
  board_interaction_request: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'HITL_REQUEST_ID_CONFLICT',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    ...AVAILABILITY_ERRORS,
  ],
  board_interaction_status: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'HITL_REQUEST_NOT_FOUND',
    ...AVAILABILITY_ERRORS,
  ],
  board_interaction_respond: [
    ...COMMON_ERRORS,
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'HITL_REQUEST_NOT_FOUND',
    'HITL_RESPONSE_CONFLICT',
    'HITL_REQUEST_EXPIRED',
    'PAYLOAD_TOO_LARGE',
    ...AVAILABILITY_ERRORS,
  ],
};

export const validTimestamp = (value) => {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};
