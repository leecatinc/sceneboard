import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoardDocumentParserV2,
  projectDocumentV2ToV3,
  type BoardDocumentV2,
  type ImageNodeV1,
  type BoardPageV2,
} from '@sceneboard/board-schema';

import {
  applyDocumentTransformV2,
  placeMediaImageOnPageV1,
} from '../../src/document-transform/index.js';

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

test('media placement preserves a V3 document format and leaves the source immutable', () => {
  const source = projectDocumentV2ToV3(document(), 'a4_landscape');
  const before = structuredClone(source);
  const result = placeMediaImageOnPageV1({
    document: source,
    pageId: 'page_a' as never,
    image: image(),
    placement: { kind: 'page-end', wrapperNodeId: 'layout_media' as never },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.value.schemaVersion, 3);
  assert.equal(result.data.value.format, 'a4_landscape');
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

const image = (id = 'image_new'): ImageNodeV1 => ({
  id: id as never,
  type: 'content.image',
  source: { type: 'media', mediaId: 'media_1' as never },
  decorative: false,
  alt: 'Uploaded image',
  fit: 'contain',
});

test('places media images at page end without mutating the source', () => {
  const empty = document();
  const emptyBefore = structuredClone(empty);
  const placedEmpty = placeMediaImageOnPageV1({
    document: empty,
    pageId: 'page_a' as never,
    image: image(),
    placement: { kind: 'page-end', wrapperNodeId: 'wrapper_new' as never },
  });
  assert.equal(placedEmpty.ok, true);
  if (!placedEmpty.ok) return;
  assert.equal(placedEmpty.data.value.pages[0]?.scene.root?.type, 'content.image');
  assert.deepEqual(empty, emptyBefore);

  const markdown = structuredClone(empty);
  markdown.pages[0]!.scene.root = {
    id: 'markdown_old' as never,
    type: 'content.markdown',
    markdown: 'Existing',
  };
  const wrapped = placeMediaImageOnPageV1({
    document: markdown,
    pageId: 'page_a' as never,
    image: image(),
    placement: { kind: 'page-end', wrapperNodeId: 'wrapper_new' as never },
  });
  assert.equal(wrapped.ok, true);
  if (!wrapped.ok) return;
  const root = wrapped.data.value.pages[0]?.scene.root;
  assert.equal(root?.type, 'layout.split');
  if (root?.type === 'layout.split') {
    assert.equal(root.direction, 'vertical');
    assert.equal(root.gap, 16);
    assert.deepEqual(
      root.children.map(({ node, weight }) => [node.id, weight]),
      [
        ['markdown_old', 1],
        ['image_new', 1],
      ],
    );
  }

  const appended = placeMediaImageOnPageV1({
    document: wrapped.data.value,
    pageId: 'page_a' as never,
    image: image('image_second'),
    placement: { kind: 'page-end', wrapperNodeId: 'unused_wrapper' as never },
  });
  assert.equal(appended.ok, true);
  if (appended.ok && appended.data.value.pages[0]?.scene.root?.type === 'layout.split')
    assert.equal(appended.data.value.pages[0].scene.root.children.length, 3);
});

test('places media images in canvas only within finite bounds', () => {
  const source = document();
  source.pages[0]!.scene.root = {
    id: 'canvas_root' as never,
    type: 'layout.canvas',
    width: 1_000,
    height: 800,
    children: [
      {
        node: {
          id: 'markdown_old' as never,
          type: 'content.markdown',
          markdown: 'Existing',
        },
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        zIndex: 0,
      },
    ],
  };
  const placed = placeMediaImageOnPageV1({
    document: source,
    pageId: 'page_a' as never,
    image: image(),
    placement: { kind: 'canvas', x: 200, y: 100, width: 640, height: 480, zIndex: 1 },
  });
  assert.equal(placed.ok, true);
  if (placed.ok && placed.data.value.pages[0]?.scene.root?.type === 'layout.canvas')
    assert.deepEqual(placed.data.value.pages[0].scene.root.children[1], {
      node: image(),
      x: 200,
      y: 100,
      width: 640,
      height: 480,
      zIndex: 1,
    });

  for (const placement of [
    { kind: 'page-end', wrapperNodeId: 'wrapper_new' },
    { kind: 'canvas', x: 900, y: 100, width: 200, height: 100, zIndex: 1 },
    { kind: 'canvas', x: Number.NaN, y: 0, width: 10, height: 10, zIndex: 1 },
  ] as const) {
    const failed = placeMediaImageOnPageV1({
      document: source,
      pageId: 'page_a' as never,
      image: image(),
      placement: placement as never,
    });
    assert.equal(failed.ok, false);
  }
});

test('rejects missing pages, cross-kind placement, and node identity collisions atomically', () => {
  const source = document();
  source.pages[0]!.scene.root = {
    id: 'existing' as never,
    type: 'content.markdown',
    markdown: 'Existing',
  };
  const before = structuredClone(source);
  const cases = [
    {
      document: source,
      pageId: 'missing',
      image: image(),
      placement: { kind: 'page-end', wrapperNodeId: 'wrapper_new' },
    },
    {
      document: source,
      pageId: 'page_a',
      image: image('existing'),
      placement: { kind: 'page-end', wrapperNodeId: 'wrapper_new' },
    },
    {
      document: source,
      pageId: 'page_a',
      image: image(),
      placement: { kind: 'page-end', wrapperNodeId: 'existing' },
    },
    {
      document: source,
      pageId: 'page_a',
      image: image(),
      placement: { kind: 'canvas', x: 0, y: 0, width: 10, height: 10, zIndex: 0 },
    },
  ];
  for (const input of cases) assert.equal(placeMediaImageOnPageV1(input as never).ok, false);
  assert.deepEqual(source, before);
});
