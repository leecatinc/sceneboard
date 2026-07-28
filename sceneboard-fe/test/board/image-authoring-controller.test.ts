import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoardDocumentParserV2,
  type BoardDocumentV2,
  type ImageNodeV1,
} from '@sceneboard/board-schema';

import {
  chooseMediaImagePlacementV1,
  createMediaImageNodeV1,
  mediaImageProjectionV1,
} from '../../lib/board/image-authoring-controller';
import { createPageCanvasTransformV1 } from '../../lib/board/page-display-mode.types';

const document = (root: BoardDocumentV2['pages'][number]['scene']['root']): BoardDocumentV2 => {
  const parsed = BoardDocumentParserV2.parse({
    schemaVersion: 2,
    defaultPageId: 'page_1',
    pages: [
      {
        pageId: 'page_1',
        title: 'Page',
        displayMode: 'fit-page',
        scene: { protocolVersion: 1, type: 'scene', root },
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid fixture');
  return parsed.data.value;
};

test('meaningful and decorative image authoring emit disjoint strict payloads', () => {
  const meaningful = createMediaImageNodeV1({
    nodeId: 'image_1' as never,
    mediaId: 'media_1' as never,
    authoring: {
      decorative: false,
      alt: 'A chart of monthly revenue',
      caption: 'Revenue trend',
      fit: 'contain',
    },
  });
  assert.deepEqual(meaningful, {
    id: 'image_1',
    type: 'content.image',
    source: { type: 'media', mediaId: 'media_1' },
    decorative: false,
    alt: 'A chart of monthly revenue',
    caption: 'Revenue trend',
    fit: 'contain',
  });
  const decorative = createMediaImageNodeV1({
    nodeId: 'image_2' as never,
    mediaId: 'media_1' as never,
    authoring: { decorative: true, alt: '', fit: 'cover' },
  });
  assert.deepEqual(decorative, {
    id: 'image_2',
    type: 'content.image',
    source: { type: 'media', mediaId: 'media_1' },
    decorative: true,
    alt: '',
    fit: 'cover',
  });
  assert.equal(Object.hasOwn(decorative!, 'caption'), false);
  assert.equal(
    createMediaImageNodeV1({
      nodeId: 'image_3' as never,
      mediaId: 'media_1' as never,
      authoring: { decorative: false, alt: '', fit: 'contain' },
    }),
    null,
  );
});

test('placement selection uses page-end or one bounded centered canvas tuple', () => {
  assert.deepEqual(
    chooseMediaImagePlacementV1({
      document: document(null),
      pageId: 'page_1' as never,
      wrapperNodeId: 'wrapper_1' as never,
      intrinsicWidth: 640,
      intrinsicHeight: 480,
    }),
    { kind: 'page-end', wrapperNodeId: 'wrapper_1' },
  );
  const canvas = document({
    id: 'canvas_1' as never,
    type: 'layout.canvas',
    width: 400,
    height: 300,
    children: [
      {
        node: {
          id: 'old_1' as never,
          type: 'content.markdown',
          markdown: 'old',
        },
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        zIndex: 3,
      },
    ],
  });
  const transform = createPageCanvasTransformV1({
    mode: 'actual-size',
    viewportWidth: 400,
    viewportHeight: 300,
    canvasWidth: 400,
    canvasHeight: 300,
  });
  assert.notEqual(transform, null);
  assert.deepEqual(
    chooseMediaImagePlacementV1({
      document: canvas,
      pageId: 'page_1' as never,
      wrapperNodeId: 'unused_1' as never,
      intrinsicWidth: 800,
      intrinsicHeight: 600,
      canvasViewport: {
        transform: transform!,
        pageViewportRect: { x: 0, y: 0, width: 400, height: 300 },
        scrollTop: 0,
      },
    }),
    { kind: 'canvas', x: 0, y: 0, width: 400, height: 300, zIndex: 4 },
  );
});

test('projection scan distinguishes exact placement, absence, and identity collision', () => {
  const image: ImageNodeV1 = {
    id: 'image_1' as never,
    type: 'content.image',
    source: { type: 'media', mediaId: 'media_1' as never },
    decorative: false,
    alt: 'Image',
    fit: 'contain',
  };
  const placement = { kind: 'page-end', wrapperNodeId: 'wrapper_1' } as const;
  assert.equal(
    mediaImageProjectionV1({
      document: document(null),
      pageId: 'page_1' as never,
      image,
      placement: placement as never,
    }),
    'absent',
  );
  assert.equal(
    mediaImageProjectionV1({
      document: document(image),
      pageId: 'page_1' as never,
      image,
      placement: placement as never,
    }),
    'exact',
  );
  assert.equal(
    mediaImageProjectionV1({
      document: document({ ...image, source: { type: 'media', mediaId: 'media_2' as never } }),
      pageId: 'page_1' as never,
      image,
      placement: placement as never,
    }),
    'collision',
  );
});
