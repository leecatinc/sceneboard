import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT_API_KEY_TOOL_POLICIES_V1 } from '../../src/tools/account-api-key-tool-policy.js';
import { API_KEY_TOOL_NAMES_V1 } from '../../src/tools/register-tools.js';

const expected = {
  board_list: { operationPlans: [{ operations: ['board.list'], scopes: ['board:read'] }] },
  board_get: { operationPlans: [{ operations: ['board.get'], scopes: ['board:read'] }] },
  board_scene_get: {
    operationPlans: [
      { operations: ['board.get'], scopes: ['board:read'] },
      { operations: ['history.get'], scopes: ['history:read'] },
    ],
  },
  board_document_get: {
    operationPlans: [
      { operations: ['board.get'], scopes: ['board:read'] },
      { operations: ['history.get'], scopes: ['history:read'] },
    ],
  },
  board_create: { operationPlans: [{ operations: ['board.create'], scopes: ['board:create'] }] },
  board_rename: { operationPlans: [{ operations: ['board.rename'], scopes: ['board:write'] }] },
  board_archive: {
    operationPlans: [{ operations: ['board.archive'], scopes: ['board:archive'] }],
  },
  board_capabilities_get: {
    operationPlans: [{ operations: ['capabilities.get'], scopes: ['board:read'] }],
  },
  board_scene_replace: {
    operationPlans: [{ operations: ['scene.replace'], scopes: ['board:write'] }],
  },
  board_scene_patch: {
    operationPlans: [
      { operations: ['board.get', 'scene.replace'], scopes: ['board:read', 'board:write'] },
    ],
  },
  board_scene_clear: {
    operationPlans: [{ operations: ['scene.clear'], scopes: ['board:write'] }],
  },
  board_document_replace: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_add: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_remove: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_reorder: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_update: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_default_set: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_history_list: {
    operationPlans: [{ operations: ['history.list'], scopes: ['history:read'] }],
  },
  board_history_get: {
    operationPlans: [{ operations: ['history.get'], scopes: ['history:read'] }],
  },
  board_history_restore: {
    operationPlans: [{ operations: ['scene.restore'], scopes: ['board:write', 'history:read'] }],
  },
  board_export: {
    operationPlans: [{ operations: ['export.render'], scopes: ['export:read'] }],
  },
};

test('MCP API-key policy exactly matches the backend owner-tool contract', () => {
  assert.deepEqual(ACCOUNT_API_KEY_TOOL_POLICIES_V1, expected);
  assert.deepEqual(API_KEY_TOOL_NAMES_V1.slice(1).sort(), Object.keys(expected).sort());
  assert.equal(API_KEY_TOOL_NAMES_V1.includes('board_pair_request' as never), false);
  assert.equal(API_KEY_TOOL_NAMES_V1.includes('sceneboard_media_place' as never), false);
});
