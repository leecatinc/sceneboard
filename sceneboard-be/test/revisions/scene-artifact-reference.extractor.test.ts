import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SceneParserV1 } from '@sceneboard/board-schema';

import {
  extractDocumentArtifactReferences,
  extractSceneArtifactReferences,
  extractUniqueDocumentArtifactPairs,
} from '../../src/revisions/scene-artifact-reference.extractor.js';

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
