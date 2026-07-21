import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) =>
  readFile(
    new URL(
      `../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/${path}`,
      import.meta.url,
    ),
    'utf8',
  );

import {
  SceneBoardApiError as CoreSceneBoardApiError,
  acquirePairingLock as acquirePairingLockFromCore,
  applyScenePatch as applyScenePatchFromCore,
  deleteCredentialIfGeneration as deleteCredentialIfGenerationFromCore,
  getOrCreateInstallationId as getOrCreateInstallationIdFromCore,
  readCredential as readCredentialFromCore,
  resolveApiConfig as resolveApiConfigFromCore,
  writeCredential as writeCredentialFromCore,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-core.mjs';
import {
  acquirePairingLock,
  deleteCredentialIfGeneration,
  getOrCreateInstallationId,
  readCredential,
  resolveApiConfig,
  writeCredential,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-config.mjs';
import {
  BOARD_LIMITS,
  OPERATION_ERROR_CODES,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-contract.mjs';
import { SceneBoardApiError } from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-error.mjs';
import {
  assertSortedCatalog,
  protectedSpec,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-request.mjs';
import { sanitizePublicValue } from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-public.mjs';
import { publicJsonTree } from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-response.mjs';
import { applyScenePatch } from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-scene-patch.mjs';

test('the fallback facade preserves the focused error and scene-patch exports', () => {
  assert.equal(CoreSceneBoardApiError, SceneBoardApiError);
  assert.equal(applyScenePatchFromCore, applyScenePatch);
});

test('the fallback facade preserves focused configuration and credential exports', () => {
  assert.equal(resolveApiConfigFromCore, resolveApiConfig);
  assert.equal(readCredentialFromCore, readCredential);
  assert.equal(writeCredentialFromCore, writeCredential);
  assert.equal(deleteCredentialIfGenerationFromCore, deleteCredentialIfGeneration);
  assert.equal(getOrCreateInstallationIdFromCore, getOrCreateInstallationId);
  assert.equal(acquirePairingLockFromCore, acquirePairingLock);
});

test('the fallback core delegates operating-system credential storage', async () => {
  const core = await source('sceneboard-api-core.mjs');

  assert.doesNotMatch(core, /WindowsPowerShell|ProtectedData|credential\.json/u);
  assert.ok(core.split('\n').length < 3_000);
});

test('the fallback protocol catalogs have one focused contract owner', async () => {
  const core = await source('sceneboard-api-core.mjs');

  assert.equal(BOARD_LIMITS.maxSceneNodes, 500);
  assert.deepEqual(OPERATION_ERROR_CODES.board_connection_status.slice(0, 2), [
    'INVALID_PAYLOAD',
    'UNAUTHENTICATED',
  ]);
  assert.doesNotMatch(core, /const BOARD_LIMITS|const OPERATION_ERROR_CODES/u);
});

test('protected operation request assembly has one focused owner', async () => {
  const core = await source('sceneboard-api-core.mjs');
  const request = protectedSpec('board_get', { boardId: 'board_123' }, 'request_123456789');

  assert.equal(request.method, 'GET');
  assert.equal(request.expectedType, 'board.get');
  assert.equal(request.correlation.boardId, 'board_123');
  assert.deepEqual(assertSortedCatalog(['download'], ['download'], 'capabilities'), ['download']);
  assert.doesNotMatch(core, /const protectedSpec|const mutationSpec|const baseMutation/u);
});

test('public response projection has one fail-closed owner', async () => {
  const core = await source('sceneboard-api-core.mjs');
  const response = await source('sceneboard-api-response.mjs');

  assert.equal(publicJsonTree({ status: 'ready', count: 1 }), true);
  assert.equal(publicJsonTree({ pairingCode: 'ABCDEF-GHJKMN' }), false);
  assert.deepEqual(sanitizePublicValue({ status: 'ready', accessToken: 'not-public' }), {
    status: 'ready',
    accessToken: '[redacted]',
  });
  assert.doesNotMatch(
    core,
    /const sanitizePublicValue|const projectBoardEnvelope|const projectHitl/u,
  );
  assert.doesNotMatch(response, /const sanitizePublicValue|const parseConnection/u);
});

test('the focused scene-patch module preserves immutable patch behavior and public errors', () => {
  const scene = {
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: 'root',
      type: 'layout.split',
      direction: 'horizontal',
      children: [
        {
          node: { id: 'before', type: 'content.markdown', markdown: 'Before' },
          weight: 1,
        },
      ],
    },
  };
  const patched = applyScenePatch(scene, [
    {
      type: 'replace_node',
      nodeId: 'before',
      node: { id: 'before', type: 'content.markdown', markdown: 'After' },
    },
  ]);

  assert.notEqual(patched, scene);
  assert.equal(scene.root.children[0].node.markdown, 'Before');
  assert.equal(patched.root.children[0].node.markdown, 'After');
  assert.throws(
    () => applyScenePatch(scene, []),
    (error) => error instanceof SceneBoardApiError && error.code === 'INVALID_PAYLOAD',
  );
});
