import {
  ARTIFACT_CAPABILITIES,
  CURSOR_PATTERN,
  GLOBAL_ID_PATTERN,
  IDEMPOTENCY_PATTERN,
  validTimestamp,
} from './sceneboard-api-contract.mjs';
import { SceneBoardApiError } from './sceneboard-api-error.mjs';
import { hasExactKeys, isRecord } from './sceneboard-api-json.mjs';

export const invalidInput = (field) => {
  throw new SceneBoardApiError('INVALID_PAYLOAD', 'Invalid SceneBoard API fallback input', {
    details: { field },
    exitCode: 2,
  });
};

export const assertExactInput = (input, keys) => {
  if (!hasExactKeys(input, keys)) invalidInput('input');
};

export const globalId = (value, field) => {
  if (typeof value !== 'string' || !GLOBAL_ID_PATTERN.test(value)) invalidInput(field);
  return value;
};

export const idempotencyKey = (value) => {
  if (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value)) invalidInput('idempotencyKey');
  return value;
};

const page = (cursor, limit) => {
  if (cursor !== null && (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor)))
    invalidInput('cursor');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidInput('limit');
};

export const baseMutation = (input, requestId, command) => ({
  protocolVersion: 1,
  requestId,
  boardId: globalId(input.boardId, 'boardId'),
  expectedRevisionId: globalId(input.expectedRevisionId, 'expectedRevisionId'),
  idempotencyKey: idempotencyKey(input.idempotencyKey),
  command,
});

export const protectedSpec = (operation, input, requestId) => {
  if (!isRecord(input)) invalidInput('input');
  if (operation === 'board_list') {
    assertExactInput(input, ['cursor', 'limit', 'includeArchived']);
    page(input.cursor, input.limit);
    if (typeof input.includeArchived !== 'boolean') invalidInput('includeArchived');
    const query = new URLSearchParams({
      requestId,
      limit: String(input.limit),
      includeArchived: String(input.includeArchived),
    });
    if (input.cursor !== null) query.set('cursor', input.cursor);
    return {
      path: `/api/v1/boards?${query}`,
      method: 'GET',
      body: null,
      expectedType: 'board.list',
      retryKind: 'read',
    };
  }
  if (operation === 'board_get' || operation === 'board_capabilities_get') {
    assertExactInput(input, ['boardId']);
    const boardId = globalId(input.boardId, 'boardId');
    const suffix = operation === 'board_get' ? '' : '/capabilities';
    return {
      path: `/api/v1/boards/${boardId}${suffix}?requestId=${requestId}`,
      method: 'GET',
      body: null,
      expectedType: operation === 'board_get' ? 'board.get' : 'capabilities.get',
      retryKind: 'read',
      correlation: { boardId },
    };
  }
  if (operation === 'board_create') {
    assertExactInput(input, ['title', 'idempotencyKey']);
    if (
      typeof input.title !== 'string' ||
      [...input.title].length < 1 ||
      [...input.title].length > 200
    )
      invalidInput('title');
    return {
      path: '/api/v1/boards',
      method: 'POST',
      body: {
        protocolVersion: 1,
        requestId,
        type: 'board.create',
        title: input.title,
        idempotencyKey: idempotencyKey(input.idempotencyKey),
      },
      expectedType: 'board.create',
      retryKind: 'mutation',
    };
  }
  if (operation === 'board_archive') {
    assertExactInput(input, ['boardId', 'confirm', 'idempotencyKey']);
    if (input.confirm !== true) invalidInput('confirm');
    const boardId = globalId(input.boardId, 'boardId');
    return {
      path: `/api/v1/boards/${boardId}/archive`,
      method: 'POST',
      body: {
        protocolVersion: 1,
        requestId,
        type: 'board.archive',
        boardId,
        confirm: true,
        idempotencyKey: idempotencyKey(input.idempotencyKey),
      },
      expectedType: 'board.archive',
      retryKind: 'mutation',
      correlation: { boardId },
    };
  }
  if (operation === 'board_scene_get') {
    assertExactInput(input, ['boardId', 'revisionId']);
    const boardId = globalId(input.boardId, 'boardId');
    if (input.revisionId === null)
      return {
        path: `/api/v1/boards/${boardId}?requestId=${requestId}`,
        method: 'GET',
        body: null,
        expectedType: 'board.get',
        retryKind: 'read',
        correlation: { boardId },
      };
    const revisionId = globalId(input.revisionId, 'revisionId');
    return {
      path: `/api/v1/boards/${boardId}/revisions/${revisionId}?requestId=${requestId}`,
      method: 'GET',
      body: null,
      expectedType: 'history.get',
      retryKind: 'read',
      correlation: { boardId, revisionId },
    };
  }
  if (operation === 'board_scene_replace') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey', 'scene']);
    if (!isRecord(input.scene)) invalidInput('scene');
    return mutationSpec(
      baseMutation(input, requestId, {
        type: 'scene.replace',
        scene: input.scene,
      }),
      'scene.replace',
    );
  }
  if (operation === 'board_scene_clear') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey']);
    return mutationSpec(baseMutation(input, requestId, { type: 'scene.clear' }), 'scene.clear');
  }
  if (operation === 'board_artifact_get') {
    assertExactInput(input, ['boardId', 'artifactId', 'versionId']);
    const boardId = globalId(input.boardId, 'boardId');
    const artifactId = globalId(input.artifactId, 'artifactId');
    const versionId = globalId(input.versionId, 'versionId');
    return {
      path: `/api/v1/boards/${boardId}/artifacts/${artifactId}/versions/${versionId}?requestId=${requestId}`,
      method: 'GET',
      body: null,
      expectedType: 'artifact.get',
      retryKind: 'read',
      correlation: { boardId, artifactId, versionId },
    };
  }
  if (operation === 'board_artifact_put') {
    assertExactInput(input, [
      'boardId',
      'expectedRevisionId',
      'idempotencyKey',
      'artifactId',
      'html',
      'css',
      'javascript',
      'requestedCapabilities',
    ]);
    globalId(input.boardId, 'boardId');
    globalId(input.expectedRevisionId, 'expectedRevisionId');
    idempotencyKey(input.idempotencyKey);
    if (input.artifactId !== null) globalId(input.artifactId, 'artifactId');
    if (
      typeof input.html !== 'string' ||
      (input.css !== null && typeof input.css !== 'string') ||
      (input.javascript !== null && typeof input.javascript !== 'string')
    )
      invalidInput('source');
    assertSortedCatalog(
      input.requestedCapabilities,
      ARTIFACT_CAPABILITIES,
      'requestedCapabilities',
      true,
    );
    return {
      path: `/api/v1/boards/${input.boardId}/artifacts`,
      method: 'POST',
      body: input,
      expectedType: 'artifact.publish',
      retryKind: 'mutation',
      correlation: {
        boardId: input.boardId,
        ...(input.artifactId === null ? {} : { artifactId: input.artifactId }),
      },
    };
  }
  if (operation === 'board_artifact_stop') {
    assertExactInput(input, [
      'boardId',
      'expectedRevisionId',
      'idempotencyKey',
      'artifactId',
      'versionId',
      'reason',
    ]);
    if (
      typeof input.reason !== 'string' ||
      [...input.reason].length < 1 ||
      [...input.reason].length > 200
    )
      invalidInput('reason');
    return {
      ...mutationSpec(
        baseMutation(input, requestId, {
          type: 'artifact.stop',
          artifact: {
            artifactId: globalId(input.artifactId, 'artifactId'),
            versionId: globalId(input.versionId, 'versionId'),
          },
          reason: input.reason,
        }),
        'artifact.stop',
      ),
      correlation: {
        boardId: input.boardId,
        artifactId: input.artifactId,
        versionId: input.versionId,
      },
    };
  }
  if (operation === 'board_history_list') {
    assertExactInput(input, ['boardId', 'cursor', 'limit']);
    const boardId = globalId(input.boardId, 'boardId');
    page(input.cursor, input.limit);
    const query = new URLSearchParams({
      requestId,
      limit: String(input.limit),
    });
    if (input.cursor !== null) query.set('cursor', input.cursor);
    return {
      path: `/api/v1/boards/${boardId}/revisions?${query}`,
      method: 'GET',
      body: null,
      expectedType: 'history.list',
      retryKind: 'read',
      correlation: { boardId },
    };
  }
  if (operation === 'board_history_get') {
    assertExactInput(input, ['boardId', 'revisionId']);
    const boardId = globalId(input.boardId, 'boardId');
    const revisionId = globalId(input.revisionId, 'revisionId');
    return {
      path: `/api/v1/boards/${boardId}/revisions/${revisionId}?requestId=${requestId}`,
      method: 'GET',
      body: null,
      expectedType: 'history.get',
      retryKind: 'read',
      correlation: { boardId, revisionId },
    };
  }
  if (operation === 'board_history_restore') {
    assertExactInput(input, [
      'boardId',
      'revisionId',
      'expectedRevisionId',
      'confirm',
      'idempotencyKey',
    ]);
    if (input.confirm !== true) invalidInput('confirm');
    const boardId = globalId(input.boardId, 'boardId');
    const revisionId = globalId(input.revisionId, 'revisionId');
    return {
      path: `/api/v1/boards/${boardId}/revisions/${revisionId}/restore`,
      method: 'POST',
      body: {
        protocolVersion: 1,
        requestId,
        idempotencyKey: idempotencyKey(input.idempotencyKey),
        expectedRevisionId: globalId(input.expectedRevisionId, 'expectedRevisionId'),
        confirm: true,
      },
      expectedType: 'scene.restore',
      retryKind: 'mutation',
      correlation: { boardId, revisionId },
    };
  }
  if (operation === 'board_interaction_request') {
    assertExactInput(input, [
      'boardId',
      'expectedRevisionId',
      'idempotencyKey',
      'hitlRequestId',
      'definition',
    ]);
    if (!isRecord(input.definition)) invalidInput('definition');
    return {
      ...mutationSpec(
        baseMutation(input, requestId, {
          type: 'hitl.request',
          hitlRequestId: globalId(input.hitlRequestId, 'hitlRequestId'),
          request: input.definition,
        }),
        'hitl.request',
      ),
      correlation: {
        boardId: input.boardId,
        hitlRequestId: input.hitlRequestId,
      },
    };
  }
  if (operation === 'board_interaction_status') {
    assertExactInput(input, ['boardId', 'hitlRequestId', 'wait']);
    const boardId = globalId(input.boardId, 'boardId');
    const hitlRequestId = globalId(input.hitlRequestId, 'hitlRequestId');
    const query = new URLSearchParams({ requestId });
    if (input.wait !== null) {
      if (
        !hasExactKeys(input.wait, ['afterStateUpdatedAt', 'timeoutMs']) ||
        !validTimestamp(input.wait.afterStateUpdatedAt) ||
        !Number.isSafeInteger(input.wait.timeoutMs) ||
        input.wait.timeoutMs < 0 ||
        input.wait.timeoutMs > 30_000
      )
        invalidInput('wait');
      query.set('afterStateUpdatedAt', input.wait.afterStateUpdatedAt);
      query.set('timeoutMs', String(input.wait.timeoutMs));
    }
    return {
      path: `/api/v1/boards/${boardId}/interactions/${hitlRequestId}?${query}`,
      method: 'GET',
      body: null,
      expectedType: 'hitl.read',
      retryKind: 'read',
      correlation: { boardId, hitlRequestId },
      minimumTimeoutMs:
        input.wait === null ? undefined : Math.max(30_000, input.wait.timeoutMs + 5_000),
    };
  }
  if (operation === 'board_interaction_respond') {
    assertExactInput(input, [
      'boardId',
      'expectedRevisionId',
      'idempotencyKey',
      'hitlRequestId',
      'response',
    ]);
    if (!isRecord(input.response)) invalidInput('response');
    return {
      ...mutationSpec(
        baseMutation(input, requestId, {
          type: 'hitl.respond',
          hitlRequestId: globalId(input.hitlRequestId, 'hitlRequestId'),
          response: input.response,
        }),
        'hitl.respond',
      ),
      correlation: {
        boardId: input.boardId,
        hitlRequestId: input.hitlRequestId,
      },
    };
  }
  invalidInput('operation');
};

export const mutationSpec = (body, expectedType) => ({
  path: `/api/v1/boards/${body.boardId}/mutations`,
  method: 'POST',
  body,
  expectedType,
  retryKind: 'mutation',
  correlation: { boardId: body.boardId },
});

export const assertSortedCatalog = (value, catalog, field, allowEmpty = false) => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > catalog.length)
    invalidInput(field);
  let previous = -1;
  for (const item of value) {
    const index = catalog.indexOf(item);
    if (index <= previous) invalidInput(field);
    previous = index;
  }
  return value;
};
