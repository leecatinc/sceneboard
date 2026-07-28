import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MysqlPublicMediaProjection } from '../../src/shares/public-media-projection.port.js';

test('public media projection binds exact active ownership metadata to the pinned public tuple', async () => {
  const order: string[] = [];
  const media = {
    findBoardOwnership: async () => {
      order.push('locator');
      return { mediaPk: 7n, status: 'active' };
    },
    lockCanonicalObjectMetadata: async () => {
      order.push('object');
      return {
        mediaPk: 7n,
        state: 'active',
        mime: 'image/webp',
        width: 320,
        height: 180,
        byteLength: 123,
        sha256: Buffer.alloc(32, 0xab),
        version: 2n,
      };
    },
    lockBoardOwnership: async () => {
      order.push('ownership');
      return { mediaPk: 7n, status: 'active' };
    },
  };
  const output = await new MysqlPublicMediaProjection(media as never).read({} as never, {
    boardPk: 3n,
    revisionPk: 5n,
    boardId: 'board_1' as never,
    revisionId: 'revision_1' as never,
    shareId: 'share_1',
    publicationGeneration: 2,
    accessGeneration: 4,
    contextId: 'A'.repeat(43),
    references: [
      {
        boardId: 'board_1' as never,
        revisionId: 'revision_1' as never,
        firstPageId: 'page_1' as never,
        mediaId: 'media_1' as never,
        ordinal: 0,
      },
    ],
  });
  assert.deepEqual(order, ['locator', 'object', 'ownership']);
  assert.deepEqual(output, [
    {
      mediaId: 'media_1',
      url: `/api/v1/public/shares/share_1/revisions/revision_1/g/2/4/media/media_1?contextId=${'A'.repeat(43)}`,
      mime: 'image/webp',
      width: 320,
      height: 180,
      etag: `"sha256-${'ab'.repeat(32)}"`,
    },
  ]);
});

test('public media projection fails closed before returning metadata for reclaimed ownership', async () => {
  const projection = new MysqlPublicMediaProjection({
    findBoardOwnership: async () => ({ mediaPk: 7n, status: 'released' }),
  } as never);
  await assert.rejects(
    projection.read({} as never, {
      boardPk: 3n,
      revisionPk: 5n,
      boardId: 'board_1' as never,
      revisionId: 'revision_1' as never,
      shareId: 'share_1',
      publicationGeneration: 2,
      accessGeneration: 4,
      contextId: 'A'.repeat(43),
      references: [
        {
          boardId: 'board_1' as never,
          revisionId: 'revision_1' as never,
          firstPageId: 'page_1' as never,
          mediaId: 'media_1' as never,
          ordinal: 0,
        },
      ],
    }),
    (error: unknown) =>
      error instanceof Error && 'status' in error && (error as { status: number }).status === 503,
  );
});
