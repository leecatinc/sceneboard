import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardDocumentParserV2 } from '@sceneboard/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import { PublicBoardRenderer } from '../src/renderer/index.js';

test('public renderer uses the shared scene tree with only its minimal public context', () => {
  const parsed = BoardDocumentParserV2.parse({
    schemaVersion: 2,
    defaultPageId: 'page_public',
    pages: [
      {
        pageId: 'page_public',
        title: 'Public page',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: 'public_markdown',
            type: 'content.markdown',
            markdown: 'Pinned public content',
          },
        },
      },
    ],
  });
  if (!parsed.ok) throw new TypeError('public renderer fixture is invalid');
  const page = parsed.data.value.pages[0]!;
  const html = renderToStaticMarkup(
    <PublicBoardRenderer
      page={page}
      context={{
        surface: 'public-share',
        boardId: 'board_public_1' as never,
        revisionId: 'revision_public_1' as never,
        publicationGeneration: 1,
        accessGeneration: 1,
        artifacts: [],
        media: [],
        selectedPageId: page.pageId,
      }}
    />,
  );
  assert.match(html, /Pinned public content/u);
  assert.doesNotMatch(html, /capabilit|presence|history|interaction response/iu);
});
