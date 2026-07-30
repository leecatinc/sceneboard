import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardDocumentParserV3, presentationFormatDescriptorV1 } from '@sceneboard/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createExportMediaResolverV1,
  ExportBoardRenderer,
  type ExportProjectionV1,
} from '../src/export/index.js';

const document = BoardDocumentParserV3.parse({
  schemaVersion: 3,
  format: 'wide_16_9',
  defaultPageId: 'page_1',
  pages: [
    {
      pageId: 'page_1',
      title: 'First',
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: { id: 'first', type: 'content.markdown', markdown: 'First export page' },
      },
    },
    {
      pageId: 'page_2',
      title: 'Second',
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: { id: 'second', type: 'content.markdown', markdown: 'Second export page' },
      },
    },
  ],
});
if (!document.ok) throw new TypeError('export renderer fixture is invalid');

const projection: ExportProjectionV1 = {
  schemaVersion: 1,
  boardId: 'AAECAwQFBgcICQoLDA0ODw' as ExportProjectionV1['boardId'],
  revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ExportProjectionV1['revisionId'],
  revisionNumber: 7,
  document: document.data.value,
  format: presentationFormatDescriptorV1('wide_16_9'),
  resources: [
    {
      sha256: 'a'.repeat(64),
      mediaType: 'image/png',
      byteLength: 8,
      url: '/internal/v1/export-render/session/resources/digest',
      usage: { kind: 'media', mediaId: 'media_1' as never },
    },
  ],
};

test('export renderer selects exactly one ordered page at the frozen viewport', () => {
  const html = renderToStaticMarkup(
    <ExportBoardRenderer
      projection={projection}
      pageIndex={1}
      runtimeOrigin="http://127.0.0.2:3412"
    />,
  );
  assert.match(html, /data-export-page="1"/u);
  assert.match(html, /width:1600px;height:900px/u);
  assert.match(html, /Second export page/u);
  assert.doesNotMatch(html, /First export page/u);
  assert.match(
    renderToStaticMarkup(
      <ExportBoardRenderer
        projection={projection}
        pageIndex={2}
        runtimeOrigin="http://127.0.0.2:3412"
      />,
    ),
    /data-export-unsupported="page"/u,
  );
});

test('export media resolver remains bound to the immutable board and revision tuple', () => {
  const resolve = createExportMediaResolverV1(projection);
  assert.deepEqual(
    resolve({
      boardId: projection.boardId,
      revisionId: projection.revisionId,
      pageId: projection.document.pages[0]!.pageId,
      mediaId: 'media_1' as never,
    }),
    { url: '/internal/v1/export-render/session/resources/digest' },
  );
  assert.deepEqual(
    resolve({
      boardId: projection.boardId,
      revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never,
      pageId: projection.document.pages[0]!.pageId,
      mediaId: 'media_1' as never,
    }),
    { error: 'unavailable' },
  );
});
