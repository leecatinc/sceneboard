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
  const client = {
    getDocumentBoard: async () => ({
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
    mutateDocument: async (request: MutationRequestV2) => {
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
      const operation = args.at(-1) as (value: typeof client) => Promise<T>;
      return {
        connected: true as const,
        value: await operation(client),
      };
    },
  };
  const handlers = new DocumentToolHandlersV2(gateway as never);
  const output = await handlers.add({
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
  });
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
