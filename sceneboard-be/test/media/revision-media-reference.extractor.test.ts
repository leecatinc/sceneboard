import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  BoardDocumentV2,
  BoardId,
  MediaId,
  PageId,
  RevisionId,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import { DenyAllMediaOwnershipProvider } from '../../src/media/deny-all-media-ownership.provider.js';
import {
  RevisionMediaReferenceExtractor,
  TooManyMediaReferencesError,
} from '../../src/media/revision-media-reference.extractor.js';
import { BoardMutationRestoreRepository } from '../../src/revisions/board-mutation.restore.repository.js';
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';

const image = (id: string, mediaId: string) => ({
  id,
  type: 'content.image' as const,
  source: { type: 'media' as const, mediaId: mediaId as MediaId },
  alt: id,
  fit: 'contain' as const,
});

test('extracts all pages in first-occurrence order and deduplicates media IDs', () => {
  const document = {
    schemaVersion: 2,
    defaultPageId: 'page_a',
    pages: [
      {
        pageId: 'page_a' as PageId,
        title: '',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: 'root_a',
            type: 'layout.split',
            direction: 'horizontal',
            gap: 0,
            children: [
              { node: image('image_a', 'media_a'), weight: 1 },
              { node: image('image_b', 'media_b'), weight: 1 },
            ],
          },
        },
      },
      {
        pageId: 'page_b' as PageId,
        title: '',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: 'root_b',
            type: 'layout.split',
            direction: 'horizontal',
            gap: 0,
            children: [
              { node: image('image_c', 'media_a'), weight: 1 },
              { node: image('image_d', 'media_c'), weight: 1 },
            ],
          },
        },
      },
    ],
  } as BoardDocumentV2;
  const references = new RevisionMediaReferenceExtractor().extract({
    boardId: 'board_1' as BoardId,
    revisionId: 'revision_1' as RevisionId,
    document,
  });
  assert.deepEqual(
    references.map(({ firstPageId, mediaId, ordinal }) => ({
      firstPageId,
      mediaId,
      ordinal,
    })),
    [
      { firstPageId: 'page_a', mediaId: 'media_a', ordinal: 1 },
      { firstPageId: 'page_a', mediaId: 'media_b', ordinal: 2 },
      { firstPageId: 'page_b', mediaId: 'media_c', ordinal: 3 },
    ],
  );
});

test('fails before allocating a 5,001st trusted-bypass reference', () => {
  const children = Array.from({ length: 5_000 }, (_, index) => ({
    node: image(`image_${index}`, `media_${index}`),
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    zIndex: index,
  }));
  const document = {
    schemaVersion: 2,
    defaultPageId: 'page_a',
    pages: [
      {
        pageId: 'page_a',
        title: '',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: 'root',
            type: 'layout.canvas',
            width: 1,
            height: 1,
            children,
          },
        },
      },
    ],
  } as unknown as BoardDocumentV2;
  const extractor = new RevisionMediaReferenceExtractor();
  const input = {
    boardId: 'board_1' as BoardId,
    revisionId: 'revision_1' as RevisionId,
    document,
  };
  assert.equal(extractor.extract(input).length, 5_000);
  children.push({
    node: image('image_5000', 'media_5000'),
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    zIndex: 5_000,
  });
  assert.throws(() => extractor.extract(input), TooManyMediaReferencesError);
});

test('deny-all ownership provider allows empty revisions and rejects media uniformly', async () => {
  const provider = new DenyAllMediaOwnershipProvider();
  await provider.assertOwnedByBoard(null as never, 1n, []);
  await assert.rejects(
    provider.assertOwnedByBoard(null as never, 1n, ['media_1' as MediaId]),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'INVALID_MEDIA_REFERENCE' &&
      error.boardError.httpStatusHint === 400 &&
      JSON.stringify(error.boardError.details) === JSON.stringify({ reason: 'unavailable' }),
  );
});

test('persists exact ordered media reference bytes under the board/revision composite key', async () => {
  let sql = '';
  let binds: unknown[] = [];
  const connection = {
    async execute(statement: string, values: unknown[]) {
      sql = statement.replace(/\s+/gu, ' ').trim();
      binds = values;
      return [{ affectedRows: 2 } as ResultSetHeader, []];
    },
  } as unknown as PoolConnection;
  await new BoardMutationRestoreRepository(new DocumentCheckpointCodec()).insertMediaReferences(
    connection,
    {
      boardPk: 10n,
      revisionPk: 20n,
      references: [
        {
          boardId: 'board_1' as BoardId,
          revisionId: 'revision_1' as RevisionId,
          firstPageId: 'page_a' as PageId,
          mediaId: 'media_a' as MediaId,
          ordinal: 1,
        },
        {
          boardId: 'board_1' as BoardId,
          revisionId: 'revision_1' as RevisionId,
          firstPageId: 'page_b' as PageId,
          mediaId: 'media_b' as MediaId,
          ordinal: 2,
        },
      ],
    },
  );
  assert.match(
    sql,
    /INSERT INTO board_revision_media_refs \( board_pk, revision_pk, media_id, first_page_id, ordinal \) VALUES \(\?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?\)/u,
  );
  assert.deepEqual(
    binds.map((value) => (Buffer.isBuffer(value) ? value.toString('ascii') : value)),
    ['10', '20', 'media_a', 'page_a', 1, '10', '20', 'media_b', 'page_b', 2],
  );
});
