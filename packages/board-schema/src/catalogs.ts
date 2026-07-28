export const NODE_TYPES_V1 = [
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
] as const;
export type NodeTypeV1 = (typeof NODE_TYPES_V1)[number];

export const BOARD_MUTATION_COMMAND_TYPES_V1 = [
  'scene.replace',
  'scene.clear',
  'scene.restore',
  'hitl.request',
  'hitl.respond',
  'artifact.publish',
  'artifact.stop',
] as const;
export type BoardMutationCommandTypeV1 = (typeof BOARD_MUTATION_COMMAND_TYPES_V1)[number];

export const BOARD_MUTATION_COMMAND_TYPES_V2 = [
  ...BOARD_MUTATION_COMMAND_TYPES_V1,
  'document.replace',
] as const;
export type BoardMutationCommandTypeV2 = (typeof BOARD_MUTATION_COMMAND_TYPES_V2)[number];

export const BOARD_OPERATION_TYPES_V1 = [
  'board.list',
  'board.get',
  'board.create',
  'board.archive',
  'capabilities.get',
  'history.list',
  'history.get',
  'artifact.get',
  'hitl.read',
] as const;
export type BoardOperationTypeV1 = (typeof BOARD_OPERATION_TYPES_V1)[number];

export const BOARD_EVENT_TYPES_V1 = [
  'board.snapshot',
  'board.revision.created',
  'hitl.updated',
  'artifact.status.changed',
  'presence.updated',
  'stream.resync.required',
  'stream.heartbeat',
  'stream.error',
] as const;
export type BoardEventTypeV1 = (typeof BOARD_EVENT_TYPES_V1)[number];

export const CLIENT_GRANT_CAPABILITIES_V1 = [
  'artifact.control',
  'artifact.publish',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'board.read',
  'board.write',
] as const;
export type ClientGrantCapabilityV1 = (typeof CLIENT_GRANT_CAPABILITIES_V1)[number];

export const BOARD_AUTHORIZATION_CAPABILITIES_V1 = [
  'account.board.create',
  'artifact.control',
  'artifact.publish',
  'board.admin',
  'board.analytics.read',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'board.media.write',
  'board.members.manage',
  'board.read',
  'board.share.manage',
  'board.write',
  'connection.manage.own',
] as const;
export type BoardAuthorizationCapabilityV1 = (typeof BOARD_AUTHORIZATION_CAPABILITIES_V1)[number];

export const BOARD_AUTHORIZATION_OPERATION_TYPES_V1 = [
  'board.list',
  'board.get',
  'capabilities.get',
  'artifact.get',
  'hitl.read',
  'history.list',
  'history.get',
  'board.create',
  'board.rename',
  'document.replace',
  'page.add',
  'page.update',
  'page.remove',
  'page.reorder',
  'page.default.set',
  'scene.replace',
  'scene.clear',
  'scene.restore',
  'hitl.request',
  'hitl.respond',
  'artifact.publish',
  'artifact.stop',
  'connection.create',
  'connection.update',
  'connection.revoke',
  'board.archive',
  'board.delete',
  'membership.list',
  'membership.invite',
  'membership.role.update',
  'membership.remove',
  'ownership.transfer',
  'share.publish',
  'share.update',
  'share.rotate',
  'share.revoke',
  'share.password.regenerate',
  'media.upload',
  'analytics.report.get',
] as const;
export type BoardAuthorizationOperationTypeV1 =
  (typeof BOARD_AUTHORIZATION_OPERATION_TYPES_V1)[number];

export const BOARD_AUTHORIZATION_SURFACES_V1 = ['browser', 'mcp'] as const;
export type BoardAuthorizationSurfaceV1 = (typeof BOARD_AUTHORIZATION_SURFACES_V1)[number];

export const BOARD_MEMBERSHIP_ROLES_V1 = ['owner', 'editor', 'viewer'] as const;
export type BoardMembershipRoleV1 = (typeof BOARD_MEMBERSHIP_ROLES_V1)[number];

export const BOARD_MEMBERSHIP_STATES_V1 = ['active', 'inactive'] as const;
export type BoardMembershipStateV1 = (typeof BOARD_MEMBERSHIP_STATES_V1)[number];

export const ARTIFACT_REQUEST_CAPABILITIES_V1 = [
  'clipboard.write',
  'download',
  'fullscreen',
  'network.fetch',
] as const;
export type ArtifactRequestCapabilityV1 = (typeof ARTIFACT_REQUEST_CAPABILITIES_V1)[number];

export const HITL_KINDS_V1 = ['info', 'choice', 'form', 'confirmation'] as const;

export const BOARD_ERROR_CODES_V1 = [
  'INVALID_PAYLOAD',
  'PROTOCOL_VERSION_MISMATCH',
  'UNKNOWN_NODE_TYPE',
  'UNKNOWN_COMMAND_TYPE',
  'UNKNOWN_OPERATION_TYPE',
  'INVALID_LAYOUT',
  'DUPLICATE_NODE_ID',
  'LIMIT_EXCEEDED',
  'PAYLOAD_TOO_LARGE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CAPABILITY_DENIED',
  'BOARD_NOT_FOUND',
  'REVISION_NOT_FOUND',
  'ARTIFACT_NOT_FOUND',
  'HITL_REQUEST_NOT_FOUND',
  'BOARD_ALREADY_ARCHIVED',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'HITL_REQUEST_ID_CONFLICT',
  'HITL_RESPONSE_CONFLICT',
  'HITL_REQUEST_EXPIRED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type BoardErrorCodeV1 = (typeof BOARD_ERROR_CODES_V1)[number];

export const BOARD_ERROR_CODES_V2 = [
  ...BOARD_ERROR_CODES_V1,
  'DOCUMENT_VERSION_MISMATCH',
  'INVALID_DOCUMENT',
] as const;
export type BoardErrorCodeV2 = (typeof BOARD_ERROR_CODES_V2)[number];
