import type { AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

import type { BoardAccessOperationV1 } from '../grants/board-access.policy.js';

export const ACCOUNT_API_KEY_BOARD_OPERATIONS_V1 = [
  'connection.get',
  'board.list',
  'board.get',
  'board.create',
  'board.rename',
  'board.archive',
  'capabilities.get',
  'scene.replace',
  'scene.clear',
  'scene.restore',
  'document.replace',
  'history.list',
  'history.get',
  'export.render',
] as const satisfies readonly (BoardAccessOperationV1 | 'connection.get')[];

export type AccountApiKeyBoardOperationV1 = (typeof ACCOUNT_API_KEY_BOARD_OPERATIONS_V1)[number];

const REQUIRED_SCOPES = {
  'connection.get': [],
  'board.list': ['board:read'],
  'board.get': ['board:read'],
  'board.create': ['board:create'],
  'board.rename': ['board:write'],
  'board.archive': ['board:archive'],
  'capabilities.get': ['board:read'],
  'scene.replace': ['board:write'],
  'scene.clear': ['board:write'],
  'scene.restore': ['board:write', 'history:read'],
  'document.replace': ['board:write'],
  'history.list': ['history:read'],
  'history.get': ['history:read'],
  'export.render': ['export:read'],
} as const satisfies Readonly<
  Record<AccountApiKeyBoardOperationV1, readonly AccountApiKeyScopeV1[]>
>;

export const accountApiKeyRequiredScopes = (
  operation: BoardAccessOperationV1 | 'connection.get' | string,
): readonly AccountApiKeyScopeV1[] | null =>
  ACCOUNT_API_KEY_BOARD_OPERATIONS_V1.includes(operation as AccountApiKeyBoardOperationV1)
    ? REQUIRED_SCOPES[operation as AccountApiKeyBoardOperationV1]
    : null;

type ToolOperationPlanV1 = Readonly<{
  operations: readonly string[];
  scopes: readonly AccountApiKeyScopeV1[];
}>;

const operationPlan = <
  const Operations extends readonly string[],
  const Scopes extends readonly AccountApiKeyScopeV1[],
>(
  operations: Operations,
  scopes: Scopes,
) => Object.freeze({ operations: Object.freeze(operations), scopes: Object.freeze(scopes) });

const toolPolicy = <const Plans extends readonly ToolOperationPlanV1[]>(...operationPlans: Plans) =>
  Object.freeze({ operationPlans: Object.freeze(operationPlans) });

const readModifyWritePlan = (operation: 'scene.replace' | 'document.replace') =>
  operationPlan(['board.get', operation], ['board:read', 'board:write']);

export const ACCOUNT_API_KEY_TOOL_POLICIES_V1 = Object.freeze({
  board_list: toolPolicy(operationPlan(['board.list'], ['board:read'])),
  board_get: toolPolicy(operationPlan(['board.get'], ['board:read'])),
  board_scene_get: toolPolicy(
    operationPlan(['board.get'], ['board:read']),
    operationPlan(['history.get'], ['history:read']),
  ),
  board_document_get: toolPolicy(
    operationPlan(['board.get'], ['board:read']),
    operationPlan(['history.get'], ['history:read']),
  ),
  board_create: toolPolicy(operationPlan(['board.create'], ['board:create'])),
  board_rename: toolPolicy(operationPlan(['board.rename'], ['board:write'])),
  board_archive: toolPolicy(operationPlan(['board.archive'], ['board:archive'])),
  board_capabilities_get: toolPolicy(operationPlan(['capabilities.get'], ['board:read'])),
  board_scene_replace: toolPolicy(operationPlan(['scene.replace'], ['board:write'])),
  board_scene_patch: toolPolicy(readModifyWritePlan('scene.replace')),
  board_scene_clear: toolPolicy(operationPlan(['scene.clear'], ['board:write'])),
  board_document_replace: toolPolicy(readModifyWritePlan('document.replace')),
  board_page_add: toolPolicy(readModifyWritePlan('document.replace')),
  board_page_remove: toolPolicy(readModifyWritePlan('document.replace')),
  board_page_reorder: toolPolicy(readModifyWritePlan('document.replace')),
  board_page_update: toolPolicy(readModifyWritePlan('document.replace')),
  board_page_default_set: toolPolicy(readModifyWritePlan('document.replace')),
  board_history_list: toolPolicy(operationPlan(['history.list'], ['history:read'])),
  board_history_get: toolPolicy(operationPlan(['history.get'], ['history:read'])),
  board_history_restore: toolPolicy(
    operationPlan(['scene.restore'], ['board:write', 'history:read']),
  ),
  board_export: toolPolicy(operationPlan(['export.render'], ['export:read'])),
} as const);

export type AccountApiKeyToolNameV1 = keyof typeof ACCOUNT_API_KEY_TOOL_POLICIES_V1;

export const accountApiKeyToolPolicy = (
  toolName: string,
): (typeof ACCOUNT_API_KEY_TOOL_POLICIES_V1)[AccountApiKeyToolNameV1] | null =>
  Object.hasOwn(ACCOUNT_API_KEY_TOOL_POLICIES_V1, toolName)
    ? ACCOUNT_API_KEY_TOOL_POLICIES_V1[toolName as AccountApiKeyToolNameV1]
    : null;
