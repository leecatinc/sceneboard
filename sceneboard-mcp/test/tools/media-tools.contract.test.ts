import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { BoardDocumentV2, MutationRequestV2 } from '@sceneboard/board-schema';
import { placeMediaImageOnPageV1 } from '@sceneboard/board-sdk/document-transform';

import {
  MediaPlaceInputSchemaV1,
  MediaToolHandlersV1,
  MediaUploadInputSchemaV1,
} from '../../src/tools/media.tools.js';
import { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';

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

const commonPlace = {
  boardId: 'board_1',
  pageId: 'page_a',
  expectedRevisionId: 'revision_1',
  idempotencyKey: 'idempotency-key-1',
  image: {
    nodeId: 'image_1',
    mediaId: 'media_1',
    decorative: false as const,
    alt: 'Example',
  },
  placement: { kind: 'page-end' as const, wrapperNodeId: 'wrapper_1' },
};

test('media inputs are exact and decorative images cannot smuggle alt or caption text', () => {
  assert.equal(
    MediaUploadInputSchemaV1.safeParse({
      boardId: 'board_1',
      path: '/tmp/image.png',
      idempotencyKey: 'idempotency-key-1',
      requestId: 'caller_request',
    }).success,
    false,
  );
  assert.equal(MediaPlaceInputSchemaV1.safeParse(commonPlace).success, true);
  assert.equal(
    MediaPlaceInputSchemaV1.safeParse({
      ...commonPlace,
      image: {
        nodeId: 'image_1',
        mediaId: 'media_1',
        decorative: true,
        alt: '',
        caption: 'forbidden',
      },
    }).success,
    false,
  );
});

test('upload authorization completes before lexical path admission', async () => {
  let authorized = false;
  const gateway = {
    withAuthorizedBoardOperation: async (
      _input: unknown,
      operation: (value: unknown) => unknown,
    ) => {
      authorized = true;
      return {
        authorized: true as const,
        value: await operation({ snapshot: {}, media: {} }),
      };
    },
  };
  const output = await new MediaToolHandlersV1(gateway as never).upload({
    boardId: 'board_1',
    path: 'relative.png',
    idempotencyKey: 'idempotency-key-1',
  });
  assert.equal(authorized, true);
  assert.equal(output.isError, true);
  assert.equal(
    (
      output.structuredContent as {
        error: { value: { code: string; details: { path: string[]; issue: string } } };
      }
    ).error.value.code,
    'BOARD_MCP_INPUT_INVALID',
  );
  assert.deepEqual(
    (
      output.structuredContent as {
        error: { value: { details: { path: string[]; issue: string } } };
      }
    ).error.value.details,
    { path: ['path'], issue: 'absolute local media path is invalid' },
  );
});

test('null and malformed credential snapshots terminate before preflight and callback work', async () => {
  for (const snapshot of [null, { version: 1, generation: 'bad', accessToken: 'bad' }]) {
    let fetchCalls = 0;
    let callbackCalls = 0;
    const gateway = new ProtectedBoardGatewayV1({
      baseUrl: 'https://sceneboard.dev',
      timeoutMs: 1_000,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('must not dispatch');
      },
      tokens: {
        snapshot: async () => snapshot as never,
        invalidate: async () => undefined,
      },
      logger: { log() {} },
    });
    const result = await gateway.withAuthorizedBoardOperation(
      {
        boardId: 'board_1',
        requestId: 'request_media_1',
        requiredCapabilities: ['board.media.write'],
      },
      async () => {
        callbackCalls += 1;
        return null;
      },
    );
    assert.equal(result.authorized, false);
    if (!result.authorized)
      assert.equal(result.reason, snapshot === null ? 'not_connected' : 'credential_unavailable');
    assert.equal(fetchCalls, 0);
    assert.equal(callbackCalls, 0);
  }
});

test('placement reads the exact revision and submits the canonical shared image transform', async () => {
  let historyRequest: Record<string, unknown> | null = null;
  let mutation: MutationRequestV2 | null = null;
  const client = {
    getDocumentHistory: async (request: Record<string, unknown>) => {
      historyRequest = request;
      return {
        ok: true as const,
        result: {
          protocolVersion: 1 as const,
          type: 'board.operation.result' as const,
          requestId: request.requestId as never,
          replayed: false,
          result: {
            type: 'history.get' as const,
            entry: {},
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
    mutateDocument: async (request: MutationRequestV2) => {
      mutation = request;
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
    withAuthorizedBoardOperation: async (
      input: { requiredCapabilities: string[] },
      operation: (value: { client: typeof client }) => unknown,
    ) => {
      assert.deepEqual(input.requiredCapabilities, ['board.history.read', 'board.write']);
      return { authorized: true as const, value: await operation({ client }) };
    },
  };
  const output = await new MediaToolHandlersV1(gateway as never).place(commonPlace);
  assert.equal(output.isError, false);
  assert.equal((historyRequest as unknown as Record<string, unknown>).revisionId, 'revision_1');
  assert.notEqual(mutation, null);
  const expected = placeMediaImageOnPageV1({
    document,
    pageId: 'page_a' as never,
    image: {
      id: 'image_1' as never,
      type: 'content.image',
      source: { type: 'media', mediaId: 'media_1' as never },
      decorative: false,
      alt: 'Example',
      fit: 'contain',
    },
    placement: { kind: 'page-end', wrapperNodeId: 'wrapper_1' as never },
  });
  assert.equal(expected.ok, true);
  const submitted = mutation as unknown as MutationRequestV2;
  if (expected.ok && submitted.command.type === 'document.replace')
    assert.deepEqual(submitted.command.document, expected.data.value);
});

test('production placement imports the SDK transform and contains no local placement algorithm', async () => {
  const source = await readFile(new URL('../../src/tools/media.tools.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /placeMediaImageOnPageV1.*@sceneboard\/board-sdk\/document-transform|@sceneboard\/board-sdk\/document-transform[\s\S]*placeMediaImageOnPageV1/u,
  );
  assert.doesNotMatch(source, /children:\s*\[\.\.\.root\.children/u);
});
