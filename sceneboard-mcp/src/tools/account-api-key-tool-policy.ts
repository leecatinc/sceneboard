import type { AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

export const ACCOUNT_API_KEY_TOOL_POLICIES_V1 = Object.freeze({
  board_list: Object.freeze({
    operation: 'board.list',
    scopes: Object.freeze(['board:read']),
  }),
  board_get: Object.freeze({
    operation: 'board.get',
    scopes: Object.freeze(['board:read']),
  }),
  board_scene_get: Object.freeze({
    operation: 'board.get',
    scopes: Object.freeze(['board:read']),
  }),
  board_document_get: Object.freeze({
    operation: 'board.get',
    scopes: Object.freeze(['board:read']),
  }),
  board_create: Object.freeze({
    operation: 'board.create',
    scopes: Object.freeze(['board:create']),
  }),
  board_rename: Object.freeze({
    operation: 'board.rename',
    scopes: Object.freeze(['board:write']),
  }),
  board_archive: Object.freeze({
    operation: 'board.archive',
    scopes: Object.freeze(['board:archive']),
  }),
  board_capabilities_get: Object.freeze({
    operation: 'capabilities.get',
    scopes: Object.freeze(['board:read']),
  }),
  board_scene_replace: Object.freeze({
    operation: 'scene.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_scene_patch: Object.freeze({
    operation: 'scene.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_scene_clear: Object.freeze({
    operation: 'scene.clear',
    scopes: Object.freeze(['board:write']),
  }),
  board_document_replace: Object.freeze({
    operation: 'document.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_page_add: Object.freeze({
    operation: 'document.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_page_remove: Object.freeze({
    operation: 'document.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_page_reorder: Object.freeze({
    operation: 'document.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_page_update: Object.freeze({
    operation: 'document.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_page_default_set: Object.freeze({
    operation: 'document.replace',
    scopes: Object.freeze(['board:write']),
  }),
  board_history_list: Object.freeze({
    operation: 'history.list',
    scopes: Object.freeze(['history:read']),
  }),
  board_history_get: Object.freeze({
    operation: 'history.get',
    scopes: Object.freeze(['history:read']),
  }),
  board_history_restore: Object.freeze({
    operation: 'scene.restore',
    scopes: Object.freeze(['board:write', 'history:read']),
  }),
  board_export: Object.freeze({
    operation: 'export.render',
    scopes: Object.freeze(['export:read']),
  }),
} as const);

export type AccountApiKeyToolNameV1 = keyof typeof ACCOUNT_API_KEY_TOOL_POLICIES_V1;
export type AccountApiKeyOperationV1 =
  (typeof ACCOUNT_API_KEY_TOOL_POLICIES_V1)[AccountApiKeyToolNameV1]['operation'];

export const accountApiKeyToolPolicyV1 = (
  toolName: string,
): Readonly<{
  operation: AccountApiKeyOperationV1;
  scopes: readonly AccountApiKeyScopeV1[];
}> | null => {
  if (!Object.hasOwn(ACCOUNT_API_KEY_TOOL_POLICIES_V1, toolName)) return null;
  const policy = ACCOUNT_API_KEY_TOOL_POLICIES_V1[toolName as AccountApiKeyToolNameV1];
  return {
    operation: policy.operation,
    scopes: policy.scopes as readonly AccountApiKeyScopeV1[],
  };
};
