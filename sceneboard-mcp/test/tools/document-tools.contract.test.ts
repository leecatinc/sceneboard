import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardDocumentV2, MutationRequestV2 } from '@sceneboard/board-schema';

import {
  DocumentToolHandlersV2,
  PageAddInputSchemaV2,
  PageUpdateInputSchemaV2,
} from '../../src/tools/document.tools.js';
import { SceneToolHandlersV1 } from '../../src/tools/scene.tools.js';

const document: BoardDocumentV2 = {
  schemaVersion: 2,
  defaultPageId: 'page_a' as never,
  pages: [
    {
      pageId: 'page_a' as never,
      title: 'A',
      displayMode: 'fit-page',
      scene: { protocolVersion: 1, type: 'scene', root: null },
    },
  ],
};

test('document page schemas reject extra fields and require an explicit update member', () => {
  const common = {
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    idempotencyKey: 'idempotency-key-1',
  };
  assert.equal(
    PageAddInputSchemaV2.safeParse({
      ...common,
      page: document.pages[0],
      index: 0,
      extra: true,
    }).success,
    false,
  );
  assert.equal(PageUpdateInputSchemaV2.safeParse({ ...common, pageId: 'page_a' }).success, false);
  assert.equal(
    PageUpdateInputSchemaV2.safeParse({
      ...common,
      pageId: 'page_a',
      title: 'Renamed',
    }).success,
    true,
  );
});

test('page tools read the V2 head, apply the shared transform, and send one whole document', async () => {
  let submitted: MutationRequestV2 | null = null;
  let gatewayCalls = 0;
  const caller = new AbortController();
  const owned = new AbortController();
  const receivedSignals: AbortSignal[] = [];
  const client = {
    getDocumentBoard: async (_request: unknown, signal: AbortSignal) => {
      receivedSignals.push(signal);
      return {
        ok: true as const,
        result: {
          protocolVersion: 1 as const,
          type: 'board.operation.result' as const,
          requestId: 'request_head',
          replayed: false,
          result: {
            type: 'board.get' as const,
            snapshot: {
              boardId: 'board_1',
              revision: { revisionId: 'revision_1' },
              document,
            },
          },
        },
        metadata: { history: null },
      };
    },
    mutateDocument: async (request: MutationRequestV2, signal: AbortSignal) => {
      receivedSignals.push(signal);
      submitted = request;
      return {
        ok: true as const,
        result: {
          protocolVersion: 1 as const,
          type: 'mutation.result' as const,
          requestId: request.requestId,
          boardId: request.boardId,
          replayed: false,
          eventIds: [],
          result: {
            type: 'document.replace' as const,
            revision: {
              revisionId: 'revision_2',
              revisionNumber: 2,
              createdAt: '2026-07-28T00:00:00.000Z',
            },
            originType: 'document.replace' as const,
            sourceRevisionId: null,
            document:
              request.command.type === 'document.replace' ? request.command.document : document,
          },
        },
        metadata: { history: null },
      };
    },
  };
  const gateway = {
    call: async <T>(...args: unknown[]) => {
      gatewayCalls += 1;
      const operation = args.at(-1) as (
        value: typeof client,
        snapshot: never,
        signal: AbortSignal,
      ) => Promise<T>;
      return {
        connected: true as const,
        value: await operation(client, {} as never, owned.signal),
      };
    },
  };
  const handlers = new DocumentToolHandlersV2(gateway as never);
  const output = await handlers.add(
    {
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      idempotencyKey: 'idempotency-key-1',
      page: {
        pageId: 'page_b',
        title: 'B',
        displayMode: 'fit-width',
        scene: { protocolVersion: 1, type: 'scene', root: null },
      },
      index: 1,
    },
    caller.signal,
  );
  assert.equal(output.isError, false);
  assert.notEqual(submitted, null);
  const command = (submitted as MutationRequestV2 | null)?.command;
  assert.equal(command?.type, 'document.replace');
  if (command?.type === 'document.replace') {
    assert.deepEqual(
      command.document.pages.map((page) => page.pageId),
      ['page_a', 'page_b'],
    );
  }
  assert.deepEqual(receivedSignals, [owned.signal, owned.signal]);
  assert.equal(receivedSignals.includes(caller.signal), false);
  assert.equal(gatewayCalls, 1);
});

test('scene patch reads and writes inside one gateway invocation', async () => {
  const owned = new AbortController();
  const receivedSignals: AbortSignal[] = [];
  let gatewayCalls = 0;
  const client = {
    getBoard: async (_request: unknown, signal: AbortSignal) => {
      receivedSignals.push(signal);
      return {
        ok: true as const,
        result: {
          protocolVersion: 1 as const,
          type: 'board.operation.result' as const,
          requestId: 'request_head',
          replayed: false,
          result: {
            type: 'board.get' as const,
            snapshot: {
              boardId: 'board_1',
              revision: { revisionId: 'revision_1' },
              scene: { protocolVersion: 1 as const, type: 'scene' as const, root: null },
            },
          },
        },
        metadata: { history: null },
      };
    },
    mutateBoard: async (_request: unknown, signal: AbortSignal) => {
      receivedSignals.push(signal);
      return {
        ok: true as const,
        result: {
          protocolVersion: 1 as const,
          type: 'mutation.result' as const,
          requestId: 'request_mutation',
          boardId: 'board_1',
          replayed: false,
          eventIds: [],
          result: {
            type: 'scene.replace' as const,
            revision: {
              revisionId: 'revision_2',
              revisionNumber: 2,
              createdAt: '2026-07-28T00:00:00.000Z',
            },
            originType: 'scene.replace' as const,
            sourceRevisionId: null,
            scene: { protocolVersion: 1 as const, type: 'scene' as const, root: null },
          },
        },
        metadata: { history: null },
      };
    },
  };
  const gateway = {
    call: async <T>(...args: unknown[]) => {
      gatewayCalls += 1;
      const operation = args.at(-1) as (
        value: typeof client,
        snapshot: never,
        signal: AbortSignal,
      ) => Promise<T>;
      return {
        connected: true as const,
        value: await operation(client, {} as never, owned.signal),
      };
    },
  };
  const result = await new SceneToolHandlersV1(gateway as never).patch({
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    idempotencyKey: 'idempotency-key-1',
    operations: [{ type: 'replace_root', root: null }],
  });
  assert.equal(result.isError, false);
  assert.equal(gatewayCalls, 1);
  assert.deepEqual(receivedSignals, [owned.signal, owned.signal]);
});

test('legacy scene get fails with the stable document mismatch on a V2 head', async () => {
  const client = {
    getBoard: async () => ({
      ok: true as const,
      result: {
        protocolVersion: 1 as const,
        type: 'board.operation.result' as const,
        requestId: 'request_head',
        replayed: false,
        result: {
          type: 'board.get' as const,
          snapshot: {
            boardId: 'board_1',
            revision: { revisionId: 'revision_1' },
            document,
          },
        },
      },
      metadata: { history: null },
    }),
  };
  const gateway = {
    call: async <T>(...args: unknown[]) => {
      const operation = args.at(-1) as (value: typeof client) => Promise<T>;
      return {
        connected: true as const,
        value: await operation(client),
      };
    },
  };
  const result = await new SceneToolHandlersV1(gateway as never).get({
    boardId: 'board_1',
    revisionId: null,
  });
  assert.equal(result.isError, true);
  assert.equal(
    (
      result.structuredContent as {
        error: { value: { code: string; details: { commandType: string } } };
      }
    ).error.value.code,
    'DOCUMENT_VERSION_MISMATCH',
  );
});

test('scene and document tools preflight their invocation-specific operation plans', async () => {
  const calls: unknown[][] = [];
  const gateway = {
    call: async (...args: unknown[]) => {
      calls.push(args.slice(0, 2));
      return { connected: false as const };
    },
  };
  const scenes = new SceneToolHandlersV1(gateway as never);
  const documents = new DocumentToolHandlersV2(gateway as never);

  await scenes.get({ boardId: 'board_1', revisionId: null });
  await scenes.get({ boardId: 'board_1', revisionId: 'revision_1' });
  await scenes.patch({
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    idempotencyKey: 'idempotency-key-1',
    operations: [{ type: 'replace_root', root: null }],
  });
  await documents.get({ boardId: 'board_1', revisionId: null });
  await documents.get({ boardId: 'board_1', revisionId: 'revision_1' });
  await documents.add({
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    idempotencyKey: 'idempotency-key-1',
    page: document.pages[0],
    index: 0,
  });

  assert.deepEqual(calls, [
    ['board_scene_get', ['board.get']],
    ['board_scene_get', ['history.get']],
    ['board_scene_patch', ['board.get', 'scene.replace']],
    ['board_document_get', ['board.get']],
    ['board_document_get', ['history.get']],
    ['board_page_add', ['board.get', 'document.replace']],
  ]);
});
