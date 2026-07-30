import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT_API_KEY_TOOL_POLICIES_V1 } from '../../src/tools/account-api-key-tool-policy.js';
import { API_KEY_TOOL_NAMES_V1 } from '../../src/tools/register-tools.js';

const expected = {
  board_list: { operation: 'board.list', scopes: ['board:read'] },
  board_get: { operation: 'board.get', scopes: ['board:read'] },
  board_scene_get: { operation: 'board.get', scopes: ['board:read'] },
  board_document_get: { operation: 'board.get', scopes: ['board:read'] },
  board_create: { operation: 'board.create', scopes: ['board:create'] },
  board_rename: { operation: 'board.rename', scopes: ['board:write'] },
  board_archive: { operation: 'board.archive', scopes: ['board:archive'] },
  board_capabilities_get: {
    operation: 'capabilities.get',
    scopes: ['board:read'],
  },
  board_scene_replace: { operation: 'scene.replace', scopes: ['board:write'] },
  board_scene_patch: { operation: 'scene.replace', scopes: ['board:write'] },
  board_scene_clear: { operation: 'scene.clear', scopes: ['board:write'] },
  board_document_replace: {
    operation: 'document.replace',
    scopes: ['board:write'],
  },
  board_page_add: { operation: 'document.replace', scopes: ['board:write'] },
  board_page_remove: {
    operation: 'document.replace',
    scopes: ['board:write'],
  },
  board_page_reorder: {
    operation: 'document.replace',
    scopes: ['board:write'],
  },
  board_page_update: {
    operation: 'document.replace',
    scopes: ['board:write'],
  },
  board_page_default_set: {
    operation: 'document.replace',
    scopes: ['board:write'],
  },
  board_history_list: { operation: 'history.list', scopes: ['history:read'] },
  board_history_get: { operation: 'history.get', scopes: ['history:read'] },
  board_history_restore: {
    operation: 'scene.restore',
    scopes: ['board:write', 'history:read'],
  },
  board_export: { operation: 'export.render', scopes: ['export:read'] },
};

test('MCP API-key policy exactly matches the backend owner-tool contract', () => {
  assert.deepEqual(ACCOUNT_API_KEY_TOOL_POLICIES_V1, expected);
  assert.deepEqual(API_KEY_TOOL_NAMES_V1.slice(1).sort(), Object.keys(expected).sort());
  assert.equal(API_KEY_TOOL_NAMES_V1.includes('board_pair_request' as never), false);
  assert.equal(API_KEY_TOOL_NAMES_V1.includes('sceneboard_media_place' as never), false);
});
