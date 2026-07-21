import { isAbsolute } from 'node:path';

import { GENERATION_PATTERN, TOKEN_PATTERN } from './sceneboard-api-config.mjs';
import {
  ARTIFACT_CAPABILITIES,
  BOARD_ERROR_CATEGORIES,
  BOARD_ERROR_STATUS,
  BOARD_LIMITS,
  CAPABILITY_SCOPES,
  COMMAND_TYPES,
  CONNECTION_VERSIONS,
  EVENT_TYPES,
  GLOBAL_ID_PATTERN,
  GRANT_SCOPES,
  HITL_KINDS,
  LIFECYCLE_PERMISSIONS,
  LOCAL_ID_PATTERN,
  NODE_TYPES,
  OPERATION_TYPES,
  PAIRING_ERROR_STATUS,
  PROOF_PATTERN,
  RETRYABLE_BOARD_ERRORS,
  SEMVER_PATTERN,
  validTimestamp,
} from './sceneboard-api-contract.mjs';
import { SceneBoardApiError } from './sceneboard-api-error.mjs';
import { hasExactKeys, isRecord } from './sceneboard-api-json.mjs';

export const safeText = (value, maximum = 200) =>
  typeof value === 'string' &&
  [...value].length >= 1 &&
  [...value].length <= maximum &&
  !/[\uD800-\uDFFF]/u.test(value);

export const validClientName = (value) =>
  safeText(value, 100) &&
  // Client-facing labels reject the complete control-character ranges.
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
  !containsSecretValue(value);

export const containsSecretValue = (value) =>
  /\blcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/u.test(value) ||
  /\b(?:Bearer|PairingProof)\s+[A-Za-z0-9._-]{16,}\b/iu.test(value) ||
  /\b[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}\b/iu.test(value);

export const SENSITIVE_CONTEXT_PATTERN =
  /(authorization|token|proof|challenge|password|cookie|secret|generation)/iu;
export const isSecretShaped = (value) =>
  typeof value === 'string' &&
  (TOKEN_PATTERN.test(value) ||
    PROOF_PATTERN.test(value) ||
    GENERATION_PATTERN.test(value) ||
    containsSecretValue(value));
export const hasContextualSecret = (contexts, values) =>
  contexts.some(
    (context) => typeof context === 'string' && SENSITIVE_CONTEXT_PATTERN.test(context),
  ) && values.some(isSecretShaped);

export const sanitizePublicValue = (value, depth = 0, budget = { count: 0 }) => {
  budget.count += 1;
  if (budget.count > 1_000 || depth > 8) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (
      [...value].length > 512 ||
      containsSecretValue(value) ||
      isAbsolute(value) ||
      /^[A-Za-z]:\\/u.test(value)
    )
      return '[redacted]';
    return value;
  }
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitizePublicValue(item, depth + 1, budget));
  if (!isRecord(value)) return null;
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (SENSITIVE_CONTEXT_PATTERN.test(key)) {
      output[key] = '[redacted]';
    } else output[key] = sanitizePublicValue(child, depth + 1, budget);
  }
  return output;
};

export const validGlobalId = (value) => typeof value === 'string' && GLOBAL_ID_PATTERN.test(value);
export const validLocalId = (value) => typeof value === 'string' && LOCAL_ID_PATTERN.test(value);
const validPublicString = (value) => typeof value === 'string' && !containsSecretValue(value);
const validErrorPath = (value) =>
  Array.isArray(value) &&
  value.every((part) => validPublicString(part) || (Number.isInteger(part) && part >= 0));
export const validArtifactReference = (value) =>
  hasExactKeys(value, ['artifactId', 'versionId']) &&
  validGlobalId(value.artifactId) &&
  validGlobalId(value.versionId);
const projectBoardErrorDetails = (code, value) => {
  if (['UNAUTHENTICATED', 'FORBIDDEN', 'BOARD_NOT_FOUND', 'INTERNAL_ERROR'].includes(code)) {
    return value === null ? null : undefined;
  }
  if (code === 'INVALID_PAYLOAD') {
    return hasExactKeys(value, ['path', 'issue']) &&
      validErrorPath(value.path) &&
      safeText(value.issue) &&
      !containsSecretValue(value.issue)
      ? { path: [...value.path], issue: value.issue }
      : undefined;
  }
  if (code === 'PROTOCOL_VERSION_MISMATCH') {
    return hasExactKeys(value, ['reason', 'supportedMajor', 'receivedMajor', 'field']) &&
      ['major', 'schema_revision', 'catalog', 'limit'].includes(value.reason) &&
      value.supportedMajor === 1 &&
      (value.receivedMajor === null ||
        (Number.isInteger(value.receivedMajor) && value.receivedMajor >= 0)) &&
      (value.field === null || validPublicString(value.field))
      ? {
          reason: value.reason,
          supportedMajor: 1,
          receivedMajor: value.receivedMajor,
          field: value.field,
        }
      : undefined;
  }
  if (['UNKNOWN_NODE_TYPE', 'UNKNOWN_COMMAND_TYPE', 'UNKNOWN_OPERATION_TYPE'].includes(code)) {
    return hasExactKeys(value, ['path', 'receivedType']) &&
      validErrorPath(value.path) &&
      validPublicString(value.receivedType)
      ? { path: [...value.path], receivedType: value.receivedType }
      : undefined;
  }
  if (code === 'INVALID_LAYOUT') {
    return hasExactKeys(value, ['path', 'reason']) &&
      validErrorPath(value.path) &&
      ['bounds', 'overlap', 'reference', 'geometry'].includes(value.reason)
      ? { path: [...value.path], reason: value.reason }
      : undefined;
  }
  if (code === 'DUPLICATE_NODE_ID') {
    return hasExactKeys(value, ['nodeId', 'firstPath', 'duplicatePath']) &&
      validLocalId(value.nodeId) &&
      validErrorPath(value.firstPath) &&
      validErrorPath(value.duplicatePath)
      ? {
          nodeId: value.nodeId,
          firstPath: [...value.firstPath],
          duplicatePath: [...value.duplicatePath],
        }
      : undefined;
  }
  if (code === 'LIMIT_EXCEEDED') {
    return hasExactKeys(value, ['limit', 'actual', 'maximum', 'path']) &&
      Object.hasOwn(BOARD_LIMITS, value.limit) &&
      typeof value.actual === 'number' &&
      Number.isFinite(value.actual) &&
      value.actual >= 0 &&
      typeof value.maximum === 'number' &&
      Number.isFinite(value.maximum) &&
      value.maximum >= 0 &&
      validErrorPath(value.path)
      ? { limit: value.limit, actual: value.actual, maximum: value.maximum, path: [...value.path] }
      : undefined;
  }
  if (code === 'PAYLOAD_TOO_LARGE') {
    return hasExactKeys(value, ['scope', 'actualBytes', 'maximumBytes']) &&
      ['envelope', 'scene', 'hitl.response', 'artifact.resource', 'artifact.total'].includes(
        value.scope,
      ) &&
      Number.isSafeInteger(value.actualBytes) &&
      value.actualBytes >= 0 &&
      Number.isSafeInteger(value.maximumBytes) &&
      value.maximumBytes > 0
      ? { scope: value.scope, actualBytes: value.actualBytes, maximumBytes: value.maximumBytes }
      : undefined;
  }
  if (code === 'CAPABILITY_DENIED') {
    return hasExactKeys(value, ['capability']) &&
      [...GRANT_SCOPES, ...ARTIFACT_CAPABILITIES].includes(value.capability)
      ? { capability: value.capability }
      : undefined;
  }
  if (code === 'REVISION_NOT_FOUND')
    return hasExactKeys(value, ['revisionId']) && validGlobalId(value.revisionId)
      ? { revisionId: value.revisionId }
      : undefined;
  if (code === 'ARTIFACT_NOT_FOUND')
    return hasExactKeys(value, ['artifact']) && validArtifactReference(value.artifact)
      ? { artifact: { ...value.artifact } }
      : undefined;
  if (code === 'HITL_REQUEST_NOT_FOUND' || code === 'HITL_REQUEST_ID_CONFLICT') {
    return hasExactKeys(value, ['hitlRequestId']) && validGlobalId(value.hitlRequestId)
      ? { hitlRequestId: value.hitlRequestId }
      : undefined;
  }
  if (code === 'BOARD_ALREADY_ARCHIVED') {
    return hasExactKeys(value, ['boardId', 'archivedAt']) &&
      validGlobalId(value.boardId) &&
      validTimestamp(value.archivedAt)
      ? { boardId: value.boardId, archivedAt: value.archivedAt }
      : undefined;
  }
  if (code === 'REVISION_CONFLICT') {
    return hasExactKeys(value, [
      'boardId',
      'expectedRevisionId',
      'actualRevisionId',
      'actualRevisionNumber',
      'recovery',
    ]) &&
      validGlobalId(value.boardId) &&
      validGlobalId(value.expectedRevisionId) &&
      validGlobalId(value.actualRevisionId) &&
      Number.isSafeInteger(value.actualRevisionNumber) &&
      value.actualRevisionNumber > 0 &&
      value.recovery === 'fetch_latest_then_retry'
      ? {
          boardId: value.boardId,
          expectedRevisionId: value.expectedRevisionId,
          actualRevisionId: value.actualRevisionId,
          actualRevisionNumber: value.actualRevisionNumber,
          recovery: value.recovery,
        }
      : undefined;
  }
  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    if (!hasExactKeys(value, ['scope', 'boardId', 'operationType', 'reason'])) return undefined;
    const variants = {
      'board.mutation': {
        boardRequired: true,
        operations: COMMAND_TYPES,
        reasons: [
          'grant_changed',
          'scopes_changed',
          'expected_revision_changed',
          'payload_changed',
        ],
      },
      'board.create': {
        boardRequired: false,
        operations: ['board.create'],
        reasons: ['grant_changed', 'scopes_changed', 'title_changed'],
      },
      'board.archive': {
        boardRequired: true,
        operations: ['board.archive'],
        reasons: ['grant_changed', 'scopes_changed'],
      },
    };
    const variant = variants[value.scope];
    if (
      variant === undefined ||
      (variant.boardRequired ? !validGlobalId(value.boardId) : value.boardId !== null) ||
      !variant.operations.includes(value.operationType) ||
      !variant.reasons.includes(value.reason)
    )
      return undefined;
    return {
      scope: value.scope,
      boardId: value.boardId,
      operationType: value.operationType,
      reason: value.reason,
    };
  }
  if (code === 'HITL_RESPONSE_CONFLICT') {
    return hasExactKeys(value, ['hitlRequestId', 'state']) &&
      validGlobalId(value.hitlRequestId) &&
      ['answered', 'superseded', 'cancelled'].includes(value.state)
      ? { hitlRequestId: value.hitlRequestId, state: value.state }
      : undefined;
  }
  if (code === 'HITL_REQUEST_EXPIRED') {
    return hasExactKeys(value, ['hitlRequestId', 'expiredAt']) &&
      validGlobalId(value.hitlRequestId) &&
      validTimestamp(value.expiredAt)
      ? { hitlRequestId: value.hitlRequestId, expiredAt: value.expiredAt }
      : undefined;
  }
  if (code === 'RATE_LIMITED') {
    return hasExactKeys(value, ['retryAfterSeconds']) &&
      typeof value.retryAfterSeconds === 'number' &&
      Number.isFinite(value.retryAfterSeconds) &&
      value.retryAfterSeconds > 0
      ? { retryAfterSeconds: value.retryAfterSeconds }
      : undefined;
  }
  if (code === 'SERVICE_UNAVAILABLE') {
    return hasExactKeys(value, ['retryAfterSeconds']) &&
      (value.retryAfterSeconds === null ||
        (typeof value.retryAfterSeconds === 'number' &&
          Number.isFinite(value.retryAfterSeconds) &&
          value.retryAfterSeconds > 0))
      ? { retryAfterSeconds: value.retryAfterSeconds }
      : undefined;
  }
  return undefined;
};

export const parseRetryAfter = (response) => {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  if (!/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$/u.test(value)) return 'invalid';
  return Number(value);
};

export const errorFromResponse = (body, response, pairing, allowedErrorCodes) => {
  if (!hasExactKeys(body, ['error']) || !isRecord(body.error)) {
    return new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
      details: { reason: 'status', status: response.status },
    });
  }
  const error = body.error;
  if (pairing) {
    const expectedStatus = PAIRING_ERROR_STATUS[error.code];
    const retryAfter = parseRetryAfter(response);
    const requiresRetryAfter = ['PAIRING_NOT_READY', 'RATE_LIMITED'].includes(error.code);
    if (
      !hasExactKeys(error, ['code', 'message']) ||
      expectedStatus !== response.status ||
      !safeText(error.message) ||
      retryAfter === 'invalid' ||
      requiresRetryAfter !== (retryAfter !== null)
    ) {
      return new SceneBoardApiError(
        'BOARD_API_RESPONSE_INVALID',
        'SceneBoard pairing response is invalid',
        {
          details: { reason: 'status' },
        },
      );
    }
    return new SceneBoardApiError(error.code, `SceneBoard pairing failed: ${error.code}`, {
      retryable: ['RATE_LIMITED', 'SERVICE_UNAVAILABLE'].includes(error.code),
      details: retryAfter === null ? null : { retryAfterSeconds: retryAfter },
    });
  }
  const expectedStatus = BOARD_ERROR_STATUS[error.code];
  const projectedDetails = projectBoardErrorDetails(error.code, error.details);
  if (
    !hasExactKeys(error, [
      'protocolVersion',
      'type',
      'code',
      'message',
      'category',
      'retryable',
      'httpStatusHint',
      'details',
    ]) ||
    error.protocolVersion !== 1 ||
    error.type !== 'board.error' ||
    expectedStatus !== response.status ||
    error.httpStatusHint !== response.status ||
    error.retryable !== RETRYABLE_BOARD_ERRORS.has(error.code) ||
    error.category !== BOARD_ERROR_CATEGORIES[error.code] ||
    !allowedErrorCodes?.includes(error.code) ||
    !safeText(error.message) ||
    containsSecretValue(error.message) ||
    projectedDetails === undefined
  ) {
    return new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
      details: { reason: 'status', status: response.status },
    });
  }
  return new SceneBoardApiError(error.code, `SceneBoard request failed: ${error.code}`, {
    retryable: error.retryable,
    details: projectedDetails,
  });
};

export const exactCatalog = (value, catalog, minimum = 0) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > catalog.length) return null;
  let previous = -1;
  for (const item of value) {
    const index = catalog.indexOf(item);
    if (index <= previous) return null;
    previous = index;
  }
  return [...value];
};

const fullCatalog = (value, catalog) =>
  Array.isArray(value) &&
  value.length === catalog.length &&
  value.every((item, index) => item === catalog[index])
    ? [...value]
    : null;

export const parseCapabilities = (value) => {
  if (
    !hasExactKeys(value, [
      'protocolVersion',
      'type',
      'schemaVersion',
      'compatibilityMode',
      'supported',
      'limits',
      'grantedCapabilities',
      'allowedArtifactRequestCapabilities',
    ]) ||
    value.protocolVersion !== 1 ||
    value.type !== 'board.capabilities' ||
    value.schemaVersion !== '1.0.0' ||
    value.compatibilityMode !== 'frozen-major' ||
    !hasExactKeys(value.supported, [
      'nodeTypes',
      'commandTypes',
      'operationTypes',
      'eventTypes',
      'hitlKinds',
      'artifactRequestCapabilities',
    ]) ||
    fullCatalog(value.supported.nodeTypes, NODE_TYPES) === null ||
    fullCatalog(value.supported.commandTypes, COMMAND_TYPES) === null ||
    fullCatalog(value.supported.operationTypes, OPERATION_TYPES) === null ||
    fullCatalog(value.supported.eventTypes, EVENT_TYPES) === null ||
    fullCatalog(value.supported.hitlKinds, HITL_KINDS) === null ||
    fullCatalog(value.supported.artifactRequestCapabilities, ARTIFACT_CAPABILITIES) === null ||
    !hasExactKeys(value.limits, Object.keys(BOARD_LIMITS)) ||
    Object.entries(BOARD_LIMITS).some(([key, expected]) => value.limits[key] !== expected)
  )
    return null;
  const grantedCapabilities = exactCatalog(value.grantedCapabilities, CAPABILITY_SCOPES);
  const allowedArtifactRequestCapabilities = exactCatalog(
    value.allowedArtifactRequestCapabilities,
    ARTIFACT_CAPABILITIES,
  );
  if (grantedCapabilities === null || allowedArtifactRequestCapabilities === null) return null;
  return {
    protocolVersion: 1,
    type: 'board.capabilities',
    schemaVersion: '1.0.0',
    compatibilityMode: 'frozen-major',
    supported: {
      nodeTypes: [...NODE_TYPES],
      commandTypes: [...COMMAND_TYPES],
      operationTypes: [...OPERATION_TYPES],
      eventTypes: [...EVENT_TYPES],
      hitlKinds: [...HITL_KINDS],
      artifactRequestCapabilities: [...ARTIFACT_CAPABILITIES],
    },
    limits: { ...BOARD_LIMITS },
    grantedCapabilities,
    allowedArtifactRequestCapabilities,
  };
};

export const parseConnection = (value, boardId) => {
  if (
    !hasExactKeys(value, ['principal', 'grant', 'selectedBoard', 'versions']) ||
    !hasExactKeys(value.principal, ['principalKind', 'principalId', 'grantId']) ||
    !hasExactKeys(value.grant, [
      'grantId',
      'client',
      'scopes',
      'lifecyclePermissions',
      'boardIds',
      'lifetime',
      'status',
      'activatedAt',
      'expiresAt',
    ]) ||
    !hasExactKeys(value.grant.client, ['clientId', 'clientName', 'installationFingerprint']) ||
    !hasExactKeys(value.versions, ['mcpServer', 'boardProtocol', 'api'])
  )
    return null;
  const { principal, grant, versions } = value;
  const client = grant.client;
  const scopes = exactCatalog(grant.scopes, GRANT_SCOPES, 1);
  const lifecyclePermissions = exactCatalog(grant.lifecyclePermissions, LIFECYCLE_PERMISSIONS);
  if (
    principal.principalKind !== 'mcp_client' ||
    !validGlobalId(principal.principalId) ||
    !validGlobalId(principal.grantId) ||
    principal.principalId !== client.clientId ||
    principal.grantId !== grant.grantId ||
    !validGlobalId(grant.grantId) ||
    !validGlobalId(client.clientId) ||
    !validClientName(client.clientName) ||
    typeof client.installationFingerprint !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/u.test(client.installationFingerprint) ||
    scopes === null ||
    lifecyclePermissions === null ||
    !Array.isArray(grant.boardIds) ||
    grant.boardIds.length > 50 ||
    (grant.boardIds.length === 0 &&
      (!scopes.includes('board.write') || !lifecyclePermissions.includes('board.create'))) ||
    grant.boardIds.some((id) => !validGlobalId(id)) ||
    new Set(grant.boardIds).size !== grant.boardIds.length ||
    !['session', 'persistent'].includes(grant.lifetime) ||
    grant.status !== 'active' ||
    !validTimestamp(grant.activatedAt) ||
    !validTimestamp(grant.expiresAt) ||
    typeof versions.mcpServer !== 'string' ||
    !SEMVER_PATTERN.test(versions.mcpServer) ||
    versions.boardProtocol !== CONNECTION_VERSIONS.boardProtocol ||
    versions.api !== CONNECTION_VERSIONS.api
  )
    return null;
  if (boardId === null && value.selectedBoard !== null) return null;
  let selectedBoard = null;
  if (boardId !== null) {
    const selected = value.selectedBoard;
    const capabilities = parseCapabilities(selected?.capabilities);
    if (
      !hasExactKeys(selected, ['board', 'capabilities', 'browserPresence']) ||
      !hasExactKeys(selected.board, [
        'boardId',
        'title',
        'createdAt',
        'updatedAt',
        'archivedAt',
        'headRevision',
      ]) ||
      !hasExactKeys(selected.board.headRevision, ['revisionId', 'revisionNumber', 'createdAt']) ||
      selected.board.boardId !== boardId ||
      !grant.boardIds.includes(boardId) ||
      !safeText(selected.board.title) ||
      containsSecretValue(selected.board.title) ||
      !validTimestamp(selected.board.createdAt) ||
      !validTimestamp(selected.board.updatedAt) ||
      (selected.board.archivedAt !== null && !validTimestamp(selected.board.archivedAt)) ||
      !validGlobalId(selected.board.headRevision.revisionId) ||
      !Number.isSafeInteger(selected.board.headRevision.revisionNumber) ||
      selected.board.headRevision.revisionNumber < 1 ||
      !validTimestamp(selected.board.headRevision.createdAt) ||
      !['online', 'offline', 'unknown'].includes(selected.browserPresence) ||
      capabilities === null
    )
      return null;
    selectedBoard = {
      board: {
        boardId: selected.board.boardId,
        title: selected.board.title,
        createdAt: selected.board.createdAt,
        updatedAt: selected.board.updatedAt,
        archivedAt: selected.board.archivedAt,
        headRevision: { ...selected.board.headRevision },
      },
      capabilities,
      browserPresence: selected.browserPresence,
    };
  }
  return {
    principal: {
      principalKind: 'mcp_client',
      principalId: principal.principalId,
      grantId: principal.grantId,
    },
    grant: {
      grantId: grant.grantId,
      client: {
        clientId: client.clientId,
        clientName: client.clientName,
        installationFingerprint: client.installationFingerprint,
      },
      scopes,
      lifecyclePermissions,
      boardIds: [...grant.boardIds],
      lifetime: grant.lifetime,
      status: 'active',
      activatedAt: grant.activatedAt,
      expiresAt: grant.expiresAt,
    },
    selectedBoard,
    versions: {
      mcpServer: versions.mcpServer,
      boardProtocol: CONNECTION_VERSIONS.boardProtocol,
      api: CONNECTION_VERSIONS.api,
    },
  };
};
