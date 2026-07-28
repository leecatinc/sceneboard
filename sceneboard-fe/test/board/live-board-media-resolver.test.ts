import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountMediaResolverV1 } from '../../lib/api/board-media-api.js';

const resolver = createAccountMediaResolverV1({
  boardId: 'board_01',
  revisionId: 'revision_01',
});

test('live board media resolver emits only the exact account-relative immutable route', () => {
  assert.deepEqual(
    resolver({
      boardId: 'board_01' as never,
      revisionId: 'revision_01' as never,
      pageId: 'page_01' as never,
      mediaId: 'media_01' as never,
    }),
    {
      url: '/api/v1/boards/board_01/revisions/revision_01/media/media_01',
    },
  );
});

test('live board resolver fails closed on tuple or identifier drift without public authority', () => {
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
      pageId: '../page',
      mediaId: 'media_01',
    },
    {
      boardId: 'board_01',
      revisionId: 'revision_01',
      pageId: 'page_01',
      mediaId: '../media',
    },
  ])
    assert.deepEqual(resolver(input as never), { error: 'unavailable' });
});
