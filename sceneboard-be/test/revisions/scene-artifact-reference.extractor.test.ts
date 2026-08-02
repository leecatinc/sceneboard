import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  SceneParserV1,
  type BoardDocumentV2,
} from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import {
  extractDocumentArtifactReferences,
  extractSceneArtifactReferences,
  extractUniqueDocumentArtifactPairs,
} from '../../src/revisions/scene-artifact-reference.extractor.js';

const referenceDocument = (groups: readonly { code: 'A' | 'I'; count: number }[]) => {
  let pageIndex = 0;
  const pages: BoardDocumentV2['pages'][number][] = [];
  for (const group of groups) {
    let remaining = group.count;
    while (remaining > 0) {
      const count = Math.min(remaining, 200);
      const currentPageIndex = pageIndex;
      pageIndex += 1;
      pages.push({
        pageId: `reference_page_${currentPageIndex}` as never,
        title: '',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: `reference_root_${currentPageIndex}` as never,
            type: 'layout.canvas',
            width: 1_000,
            height: 10,
            children: Array.from({ length: count }, (_, nodeIndex) => ({
              node:
                group.code === 'A'
                  ? {
                      id: `reference_a_${currentPageIndex}_${nodeIndex}` as never,
                      type: 'content.artifact' as const,
                      artifact: { artifactId: 'asset_1' as never, versionId: 'version_1' as never },
                      fallbackText: 'fallback',
                    }
                  : {
                      id: `reference_i_${currentPageIndex}_${nodeIndex}` as never,
                      type: 'content.image' as const,
                      source: {
                        type: 'artifact.resource' as const,
                        artifact: {
                          artifactId: 'asset_1' as never,
                          versionId: 'version_1' as never,
                        },
                        path: 'image.png',
                        sha256: 'a'.repeat(64),
                      },
                      alt: 'image',
                      fit: 'contain' as const,
                    },
              x: nodeIndex,
              y: 0,
              width: 1,
              height: 1,
              zIndex: nodeIndex,
            })),
          },
        },
      } as BoardDocumentV2['pages'][number]);
      remaining -= count;
    }
  }
  return {
    schemaVersion: 2,
    defaultPageId: pages[0]?.pageId ?? ('reference_page_0' as never),
    pages,
  } satisfies BoardDocumentV2;
};

test('extracts and deterministically counts direct and image artifact references', () => {
  const scene = SceneParserV1.parse({
    protocolVersion: 1 as const,
    type: 'scene' as const,
    root: {
      id: 'root',
      type: 'layout.split' as const,
      direction: 'horizontal' as const,
      gap: 0,
      children: [
        {
          node: {
            id: 'artifact',
            type: 'content.artifact' as const,
            artifact: { artifactId: 'asset_1', versionId: 'version_1' },
            fallbackText: 'fallback',
          },
          weight: 1,
        },
        {
          node: {
            id: 'image',
            type: 'content.image' as const,
            source: {
              type: 'artifact.resource' as const,
              artifact: { artifactId: 'asset_1', versionId: 'version_1' },
              path: 'image.png',
              sha256: 'a'.repeat(64),
            },
            alt: 'image',
            fit: 'contain' as const,
          },
          weight: 1,
        },
      ],
    },
  });
  assert.equal(scene.ok, true);
  if (!scene.ok) return;

  assert.deepEqual(extractSceneArtifactReferences(scene.data.value), [
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'A',
      occurrenceCount: 1,
    },
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'I',
      occurrenceCount: 1,
    },
  ]);
});

test('aggregates all document pages while preserving first-page pair order', () => {
  const artifact = (id: string, artifactId: string) => ({
    protocolVersion: 1 as const,
    type: 'scene' as const,
    root: {
      id,
      type: 'content.artifact' as const,
      artifact: { artifactId, versionId: 'version_1' },
      fallbackText: '',
    },
  });
  const document = {
    schemaVersion: 2 as const,
    defaultPageId: 'page_1',
    pages: [
      {
        pageId: 'page_1',
        title: '',
        displayMode: 'fit-page' as const,
        scene: artifact('node_1', 'asset_2'),
      },
      {
        pageId: 'page_2',
        title: '',
        displayMode: 'fit-page' as const,
        scene: artifact('node_2', 'asset_1'),
      },
    ],
  } as never;
  assert.deepEqual(extractDocumentArtifactReferences(document), [
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'A',
      occurrenceCount: 1,
    },
    {
      artifactId: 'asset_2',
      artifactVersionId: 'version_1',
      referenceCode: 'A',
      occurrenceCount: 1,
    },
  ]);
  assert.deepEqual(extractUniqueDocumentArtifactPairs(document), [
    { artifactId: 'asset_2', artifactVersionId: 'version_1' },
    { artifactId: 'asset_1', artifactVersionId: 'version_1' },
  ]);
});

test('uses the public 500-occurrence limit as an extractor invariant and counts A/I separately', () => {
  const boundary = referenceDocument([
    { code: 'A', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
    { code: 'I', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
  ]);
  assert.deepEqual(extractDocumentArtifactReferences(boundary), [
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'A',
      occurrenceCount: 500,
    },
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'I',
      occurrenceCount: 500,
    },
  ]);

  for (const code of ['A', 'I'] as const)
    assert.throws(
      () =>
        extractDocumentArtifactReferences(
          referenceDocument([{ code, count: MAX_ARTIFACT_REFERENCE_OCCURRENCES + 1 }]),
        ),
      (error: unknown) =>
        error instanceof BoardPersistenceError && error.category === 'row_integrity',
    );
});
