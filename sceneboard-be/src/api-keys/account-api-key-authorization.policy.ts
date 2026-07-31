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

export const ACCOUNT_API_KEY_TOOL_POLICIES_V1 = Object.freeze({
  board_list: Object.freeze({ operation: 'board.list', scopes: Object.freeze(['board:read']) }),
  board_get: Object.freeze({ operation: 'board.get', scopes: Object.freeze(['board:read']) }),
  board_scene_get: Object.freeze({ operation: 'board.get', scopes: Object.freeze(['board:read']) }),
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

export const accountApiKeyToolPolicy = (
  toolName: string,
): (typeof ACCOUNT_API_KEY_TOOL_POLICIES_V1)[AccountApiKeyToolNameV1] | null =>
  Object.hasOwn(ACCOUNT_API_KEY_TOOL_POLICIES_V1, toolName)
    ? ACCOUNT_API_KEY_TOOL_POLICIES_V1[toolName as AccountApiKeyToolNameV1]
    : null;
