import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BoardDocumentParserV2,
  BoardSnapshotParserV1,
  type BoardSnapshotV1,
} from '@sceneboard/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import { BoardRenderer } from '../src/renderer/index.js';
import { rendererTestInputV2 } from './renderer-test-input.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../board-schema/test/fixtures/valid/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;

test('renderer emits only the selected page root with snapshot-wide context intact', () => {
  const parsedSnapshot = BoardSnapshotParserV1.parse(fixture('snapshot-board.v1.json'));
  if (!parsedSnapshot.ok) throw new TypeError('snapshot fixture is invalid');
  const snapshot = parsedSnapshot.data.value as BoardSnapshotV1;
  const parsedDocument = BoardDocumentParserV2.parse({
    schemaVersion: 2,
    defaultPageId: 'page_a',
    pages: ['a', 'b'].map((suffix) => ({
      pageId: `page_${suffix}`,
      title: `Page ${suffix}`,
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: {
          id: `node_${suffix}`,
          type: 'content.markdown',
          markdown: `Selected ${suffix.toUpperCase()}`,
        },
      },
    })),
  });
  if (!parsedDocument.ok) throw new TypeError('document fixture is invalid');
  const page = parsedDocument.data.value.pages[1];
  if (page === undefined) throw new TypeError('selected page fixture is missing');
  const legacyInput = rendererTestInputV2(snapshot);
  const html = renderToStaticMarkup(
    <BoardRenderer
      page={page}
      context={{
        ...legacyInput.context,
        documentSchemaVersion: 2,
        selectedPageId: page.pageId,
      }}
    />,
  );
  assert.match(html, /Selected B/u);
  assert.doesNotMatch(html, /Selected A/u);
});
