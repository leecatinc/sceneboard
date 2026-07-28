import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoardDocumentParserV2,
  type BoardDocumentV2,
  type BoardPageV2,
} from '@sceneboard/board-schema';

import { applyDocumentTransformV2 } from '../../src/document-transform/index.js';

const page = (pageId: string, title = pageId): BoardPageV2 => ({
  pageId: pageId as never,
  title,
  displayMode: 'fit-page',
  scene: { protocolVersion: 1, type: 'scene', root: null },
});

const document = (): BoardDocumentV2 => {
  const parsed = BoardDocumentParserV2.parse({
    schemaVersion: 2,
    defaultPageId: 'page_a',
    pages: [page('page_a', 'A'), page('page_b', 'B')],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid fixture');
  return parsed.data.value;
};

test('applies add, update, reorder, default, remove, and replace without mutating the source', () => {
  const source = document();
  const before = structuredClone(source);
  const added = applyDocumentTransformV2(source, {
    type: 'page.add',
    page: page('page_c', 'C'),
    index: 1,
  });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const updated = applyDocumentTransformV2(added.data.value, {
    type: 'page.update',
    pageId: 'page_c' as never,
    title: 'Renamed',
    displayMode: 'fit-width',
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  const reordered = applyDocumentTransformV2(updated.data.value, {
    type: 'page.reorder',
    pageId: 'page_c' as never,
    toIndex: 2,
  });
  assert.equal(reordered.ok, true);
  if (!reordered.ok) return;
  const defaulted = applyDocumentTransformV2(reordered.data.value, {
    type: 'page.default.set',
    pageId: 'page_c' as never,
  });
  assert.equal(defaulted.ok, true);
  if (!defaulted.ok) return;
  const removed = applyDocumentTransformV2(defaulted.data.value, {
    type: 'page.remove',
    pageId: 'page_b' as never,
  });
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.deepEqual(
    removed.data.value.pages.map(({ pageId }) => pageId),
    ['page_a', 'page_c'],
  );
  assert.equal(removed.data.value.pages[1]?.title, 'Renamed');
  assert.equal(removed.data.value.defaultPageId, 'page_c');

  const replaced = applyDocumentTransformV2(removed.data.value, {
    type: 'document.replace',
    document: source,
  });
  assert.equal(replaced.ok, true);
  if (replaced.ok) assert.deepEqual(replaced.data.value, source);
  assert.deepEqual(source, before);
});

test('fails atomically for unknown pages, invalid indices, last/default removal, and empty updates', () => {
  const cases = [
    { type: 'page.add', page: page('page_c'), index: 3 },
    { type: 'page.remove', pageId: 'missing' },
    { type: 'page.remove', pageId: 'page_a' },
    { type: 'page.reorder', pageId: 'page_b', toIndex: 2 },
    { type: 'page.update', pageId: 'page_a' },
    { type: 'page.default.set', pageId: 'missing' },
  ] as const;
  for (const operation of cases) {
    const source = document();
    const before = structuredClone(source);
    const result = applyDocumentTransformV2(source, operation as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_DOCUMENT');
    assert.deepEqual(source, before);
  }

  const single = BoardDocumentParserV2.parse({
    schemaVersion: 2,
    defaultPageId: 'only',
    pages: [page('only')],
  });
  assert.equal(single.ok, true);
  if (!single.ok) return;
  const removed = applyDocumentTransformV2(single.data.value, {
    type: 'page.remove',
    pageId: 'only' as never,
  });
  assert.equal(removed.ok, false);
  if (!removed.ok) assert.equal(removed.error.code, 'INVALID_DOCUMENT');
});

test('rejects extra operation fields and duplicate page/node identities through the shared parser', () => {
  const source = document();
  const extra = applyDocumentTransformV2(source, {
    type: 'page.default.set',
    pageId: 'page_b',
    extra: true,
  } as never);
  assert.equal(extra.ok, false);

  const duplicatePage = applyDocumentTransformV2(source, {
    type: 'page.add',
    page: page('page_a'),
    index: 1,
  });
  assert.equal(duplicatePage.ok, false);
  if (!duplicatePage.ok) assert.equal(duplicatePage.error.code, 'INVALID_DOCUMENT');
});
