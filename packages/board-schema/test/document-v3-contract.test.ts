import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardDocumentParserV2,
  BoardDocumentParserV3,
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  PublicBoardProjectionParserV1,
  presentationFormatDescriptorV1,
  projectDocumentV2ToV3,
  projectDocumentV3ToV2,
  type BoardDocumentV2,
} from '../src/index.js';

const documentV2: BoardDocumentV2 = {
  schemaVersion: 2,
  defaultPageId: 'page_1' as BoardDocumentV2['defaultPageId'],
  pages: [
    {
      pageId: 'page_1' as BoardDocumentV2['pages'][number]['pageId'],
      title: 'Synthetic page' as BoardDocumentV2['pages'][number]['title'],
      displayMode: 'fit-page',
      scene: { protocolVersion: 1, type: 'scene', root: null },
    },
  ],
};

const artifactReferenceDocumentV3 = (groups: readonly { code: 'A' | 'I'; count: number }[]) => {
  let pageIndex = 0;
  const pages: unknown[] = [];
  for (const group of groups) {
    let remaining = group.count;
    while (remaining > 0) {
      const count = Math.min(remaining, 200);
      const currentPageIndex = pageIndex;
      pageIndex += 1;
      pages.push({
        pageId: `reference_page_${currentPageIndex}`,
        title: '',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: `reference_root_${currentPageIndex}`,
            type: 'layout.canvas',
            width: 1_000,
            height: 10,
            children: Array.from({ length: count }, (_, nodeIndex) => ({
              node:
                group.code === 'A'
                  ? {
                      id: `reference_a_${currentPageIndex}_${nodeIndex}`,
                      type: 'content.artifact',
                      artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                      fallbackText: 'fallback',
                    }
                  : {
                      id: `reference_i_${currentPageIndex}_${nodeIndex}`,
                      type: 'content.image',
                      source: {
                        type: 'artifact.resource',
                        artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                        path: 'image.png',
                        sha256: 'a'.repeat(64),
                      },
                      alt: 'image',
                      fit: 'contain',
                    },
              x: nodeIndex,
              y: 0,
              width: 1,
              height: 1,
              zIndex: nodeIndex,
            })),
          },
        },
      });
      remaining -= count;
    }
  }
  return {
    schemaVersion: 3,
    format: 'wide_16_9',
    defaultPageId: 'reference_page_0',
    pages,
  };
};

test('freezes all presentation format descriptors', () => {
  assert.deepEqual(presentationFormatDescriptorV1('wide_16_9'), {
    format: 'wide_16_9',
    css: { width: 1600, height: 900 },
    pdf: { widthMm: 338.67, heightMm: 190.5 },
    pptx: { widthIn: 13.333, heightIn: 7.5 },
  });
  assert.deepEqual(presentationFormatDescriptorV1('standard_4_3'), {
    format: 'standard_4_3',
    css: { width: 1600, height: 1200 },
    pdf: { widthMm: 254, heightMm: 190.5 },
    pptx: { widthIn: 10, heightIn: 7.5 },
  });
  assert.deepEqual(presentationFormatDescriptorV1('a4_portrait'), {
    format: 'a4_portrait',
    css: { width: 794, height: 1123 },
    pdf: { widthMm: 210, heightMm: 297 },
    pptx: { widthIn: 8.2677, heightIn: 11.6929 },
  });
  assert.deepEqual(presentationFormatDescriptorV1('a4_landscape'), {
    format: 'a4_landscape',
    css: { width: 1123, height: 794 },
    pdf: { widthMm: 297, heightMm: 210 },
    pptx: { widthIn: 11.6929, heightIn: 8.2677 },
  });
});

test('projects V2 to strict V3 and back without changing page content', () => {
  const documentV3 = projectDocumentV2ToV3(documentV2);
  assert.deepEqual(documentV3, {
    schemaVersion: 3,
    format: 'wide_16_9',
    defaultPageId: documentV2.defaultPageId,
    pages: documentV2.pages,
  });
  assert.deepEqual(projectDocumentV3ToV2(documentV3), documentV2);
  assert.equal(BoardDocumentParserV3.parse(documentV3).ok, true);
  assert.equal(BoardDocumentParserV2.parse(documentV2).ok, true);
  assert.equal(BoardDocumentParserV3.parse({ ...documentV3, format: 'unknown' }).ok, false);
  assert.equal(BoardDocumentParserV3.parse({ ...documentV3, extra: true }).ok, false);
});

test('enforces separate exact A and I occurrence ceilings across V3 pages', () => {
  for (const code of ['A', 'I'] as const) {
    assert.equal(
      BoardDocumentParserV3.parse(
        artifactReferenceDocumentV3([{ code, count: MAX_ARTIFACT_REFERENCE_OCCURRENCES }]),
      ).ok,
      true,
    );
    const over = BoardDocumentParserV3.parse(
      artifactReferenceDocumentV3([{ code, count: MAX_ARTIFACT_REFERENCE_OCCURRENCES + 1 }]),
    );
    assert.equal(over.ok, false);
    if (!over.ok) {
      assert.equal(over.error.code, 'INVALID_DOCUMENT');
      assert.equal(over.error.httpStatusHint, 422);
      assert.equal(over.error.details.reason, 'limit');
    }
  }
  assert.equal(
    BoardDocumentParserV3.parse(
      artifactReferenceDocumentV3([
        { code: 'A', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
        { code: 'I', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
      ]),
    ).ok,
    true,
  );
  const mixedOver = BoardDocumentParserV3.parse(
    artifactReferenceDocumentV3([
      { code: 'A', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES + 1 },
      { code: 'I', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
    ]),
  );
  assert.equal(mixedOver.ok, false);
  if (!mixedOver.ok) {
    assert.equal(mixedOver.error.code, 'INVALID_DOCUMENT');
    assert.equal(mixedOver.error.httpStatusHint, 422);
  }
});

test('public projection admits a sanitized V3 document and preserves only its presentation format', () => {
  const projection = {
    shareId: 'share_1',
    boardId: 'AAECAwQFBgcICQoLDA0ODw',
    revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publicationGeneration: 1,
    accessGeneration: 1,
    title: 'Public deck',
    document: projectDocumentV2ToV3(documentV2, 'standard_4_3'),
    artifacts: [],
    media: [],
  };
  const parsed = PublicBoardProjectionParserV1.parse(projection);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.value.document.schemaVersion, 3);
  if (parsed.data.value.document.schemaVersion === 3)
    assert.equal(parsed.data.value.document.format, 'standard_4_3');
  assert.deepEqual(Object.keys(parsed.data.value).sort(), [
    'accessGeneration',
    'artifacts',
    'boardId',
    'document',
    'media',
    'publicationGeneration',
    'revisionId',
    'shareId',
    'title',
  ]);
});
