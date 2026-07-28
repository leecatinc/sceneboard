import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardPageV2 } from '@sceneboard/board-schema';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PublicBoardRenderer,
  publicRenderTreeIsReadyV1,
  type MediaResolverV1,
} from '../src/renderer/index.js';

test('public renderer marks pending images while account renderer props remain unchanged', () => {
  const page = {
    pageId: 'page_1',
    title: 'Image',
    displayMode: 'fit-page',
    scene: {
      protocolVersion: 1,
      type: 'scene',
      root: {
        id: 'image_1',
        type: 'content.image',
        source: { type: 'media', mediaId: 'media_1' },
        alt: 'Image',
        fit: 'contain',
      },
    },
  } as BoardPageV2;
  const resolver: MediaResolverV1 = () => ({
    url: '/api/v1/public/media_1',
    metadata: {
      mime: 'image/png',
      width: 20,
      height: 10,
      etag: `"sha256-${'a'.repeat(64)}"`,
    },
  });
  const markup = renderToStaticMarkup(
    <PublicBoardRenderer
      page={page}
      mediaResolver={resolver}
      renderEpoch={7}
      onRenderReady={() => undefined}
      context={{
        surface: 'public-share',
        boardId: 'board_1' as never,
        revisionId: 'revision_1' as never,
        publicationGeneration: 1,
        accessGeneration: 1,
        artifacts: [],
        media: [],
        selectedPageId: page.pageId,
      }}
    />,
  );
  assert.match(markup, /data-public-render-epoch="7"/u);
  assert.match(markup, /data-public-render-resource="image"/u);
});

test('readiness refuses disconnected, failed, and unsettled resource trees', () => {
  const priorImage = Object.getOwnPropertyDescriptor(globalThis, 'HTMLImageElement');
  class FakeImage {
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
  }
  Object.defineProperty(globalThis, 'HTMLImageElement', {
    configurable: true,
    value: FakeImage,
  });
  try {
    const image = new FakeImage();
    const root = {
      isConnected: true,
      querySelector: () => null,
      querySelectorAll: () => [image],
    } as unknown as HTMLElement;
    assert.equal(publicRenderTreeIsReadyV1(root), false);
    image.complete = true;
    image.naturalWidth = 20;
    image.naturalHeight = 10;
    assert.equal(publicRenderTreeIsReadyV1(root), true);
    (root as unknown as { querySelector: () => object }).querySelector = () => ({});
    assert.equal(publicRenderTreeIsReadyV1(root), false);
    (root as unknown as { isConnected: boolean }).isConnected = false;
    assert.equal(publicRenderTreeIsReadyV1(root), false);
  } finally {
    if (priorImage === undefined) Reflect.deleteProperty(globalThis, 'HTMLImageElement');
    else Object.defineProperty(globalThis, 'HTMLImageElement', priorImage);
  }
});
