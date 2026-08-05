import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPublicShareMediaResolverV1,
  decodePublicShareClientState,
} from '../../lib/api/public-share-contract.js';

const contextId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const publicUrl =
  '/api/v1/public/shares/share_01/revisions/revision_01/g/3/4/media/media_01' +
  `?contextId=${contextId}`;
const readyInput = {
  state: 'ready',
  projection: {
    shareId: 'share_01',
    boardId: 'board_01',
    revisionId: 'revision_01',
    publicationGeneration: 3,
    accessGeneration: 4,
    title: 'Public board',
    document: {
      schemaVersion: 2,
      defaultPageId: 'page_01',
      pages: [
        {
          pageId: 'page_01',
          title: 'Image',
          displayMode: 'fit-page',
          scene: {
            protocolVersion: 1,
            type: 'scene',
            root: {
              id: 'image_01',
              type: 'content.image',
              source: { type: 'media', mediaId: 'media_01' },
              alt: 'Pinned image',
              fit: 'contain',
            },
          },
        },
      ],
    },
    artifacts: [],
    media: [
      {
        mediaId: 'media_01',
        url: publicUrl,
        mime: 'image/webp',
        width: 1_000,
        height: 500,
        etag: `"sha256-${'b'.repeat(64)}"`,
      },
    ],
  },
  context: {
    contextId,
    validUntil: '2026-07-28T00:01:00.000Z',
  },
} as const;

const ready = decodePublicShareClientState(readyInput);
if (ready.state !== 'ready') throw new TypeError('public ready fixture is invalid');

test('shared resolver returns only the current token-free projection entry unchanged', () => {
  const resolution = createPublicShareMediaResolverV1(ready)({
    boardId: 'board_01' as never,
    revisionId: 'revision_01' as never,
    pageId: 'page_01' as never,
    mediaId: 'media_01' as never,
  });
  assert.deepEqual(resolution, {
    url: publicUrl,
    metadata: {
      mime: 'image/webp',
      width: 1_000,
      height: 500,
      etag: `"sha256-${'b'.repeat(64)}"`,
    },
  });
  assert.doesNotMatch(JSON.stringify(resolution), /shareToken|cookie|authorization/iu);
});

test('shared resolver denies cross-tuple, wrong-page, absent, duplicate, and absolute resources', () => {
  const resolver = createPublicShareMediaResolverV1(ready);
  for (const input of [
    {
      boardId: 'board_02',
      revisionId: 'revision_01',
      pageId: 'page_01',
      mediaId: 'media_01',
    },
    {
      boardId: 'board_01',
      revisionId: 'revision_02',
      pageId: 'page_01',
      mediaId: 'media_01',
    },
    {
      boardId: 'board_01',
      revisionId: 'revision_01',
      pageId: 'page_02',
      mediaId: 'media_01',
    },
    {
      boardId: 'board_01',
      revisionId: 'revision_01',
      pageId: 'page_01',
      mediaId: 'media_02',
    },
  ])
    assert.deepEqual(resolver(input as never), { error: 'unavailable' });

  for (const corrupt of [
    {
      ...readyInput,
      projection: {
        ...readyInput.projection,
        media: [readyInput.projection.media[0], readyInput.projection.media[0]],
      },
    },
    {
      ...readyInput,
      projection: {
        ...readyInput.projection,
        media: [{ ...readyInput.projection.media[0], url: 'https://example.test/image.webp' }],
      },
    },
  ]) {
    const deny = createPublicShareMediaResolverV1(corrupt as never);
    assert.deepEqual(
      deny({
        boardId: 'board_01' as never,
        revisionId: 'revision_01' as never,
        pageId: 'page_01' as never,
        mediaId: 'media_01' as never,
      }),
      { error: 'unavailable' },
    );
  }
});

test('shared resolver fails closed for artifact inputs', () => {
  assert.deepEqual(
    createPublicShareMediaResolverV1(ready)({
      boardId: 'board_01' as never,
      revisionId: 'revision_01' as never,
      pageId: 'page_01' as never,
      artifact: {} as never,
      path: 'preview.png',
      sha256: '0'.repeat(64),
    }),
    { error: 'unavailable' },
  );
});
