import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SceneParserV1 } from '@leecat-board/board-schema';

import { extractSceneArtifactReferences } from '../../src/revisions/scene-artifact-reference.extractor.js';

test('extracts and deterministically counts direct and image artifact references', () => {
  const scene = SceneParserV1.parse({
    protocolVersion: 1 as const,
    type: 'scene' as const,
    root: {
      id: 'root', type: 'layout.split' as const, direction: 'horizontal' as const, gap: 0,
      children: [{
        node: { id: 'artifact', type: 'content.artifact' as const,
          artifact: { artifactId: 'asset_1', versionId: 'version_1' }, fallbackText: 'fallback' }, weight: 1,
      }, {
        node: { id: 'image', type: 'content.image' as const,
          source: { type: 'artifact.resource' as const, artifact: { artifactId: 'asset_1', versionId: 'version_1' }, path: 'image.png', sha256: 'a'.repeat(64) },
          alt: 'image', fit: 'contain' as const }, weight: 1,
      }],
    },
  });
  assert.equal(scene.ok, true);
  if (!scene.ok) return;

  assert.deepEqual(extractSceneArtifactReferences(scene.data.value), [{
    artifactId: 'asset_1', artifactVersionId: 'version_1', referenceCode: 'A', occurrenceCount: 1,
  }, {
    artifactId: 'asset_1', artifactVersionId: 'version_1', referenceCode: 'I', occurrenceCount: 1,
  }]);
});
