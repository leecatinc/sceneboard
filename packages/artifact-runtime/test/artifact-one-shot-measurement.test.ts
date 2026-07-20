import assert from 'node:assert/strict';
import test from 'node:test';

import { measureArtifactContentSizeV1, type ArtifactMeasuredCandidateV1 } from '../src/bridge/index.js';

const candidate = (input: Partial<ArtifactMeasuredCandidateV1> = {}): ArtifactMeasuredCandidateV1 => ({
  left: 0,
  top: 0,
  right: 1_200,
  bottom: 675,
  scrollWidth: 1_200,
  scrollHeight: 675,
  ...input,
});

test('uses the canonical empty measurement', () => {
  assert.deepEqual(measureArtifactContentSizeV1({ left: 0, top: 0 }, []), { width: 1_200, height: 675 });
});

test('measures transformed, overflow, and negative-origin candidates from body origin', () => {
  assert.deepEqual(measureArtifactContentSizeV1({ left: 10, top: 20 }, [candidate({ left: 10, top: 20, right: 1_310.2, bottom: 720.1 })]), { width: 1_301, height: 701 });
  assert.deepEqual(measureArtifactContentSizeV1({ left: 0, top: 0 }, [candidate({ right: 100, bottom: 100, scrollWidth: 1_801, scrollHeight: 901 })]), { width: 1_801, height: 901 });
  assert.deepEqual(measureArtifactContentSizeV1({ left: -100, top: -50 }, [candidate({ left: -75, top: -25, right: 1_225.4, bottom: 700.2 })]), { width: 1_326, height: 751 });
});

test('preserves tall narrow content and clamps every output boundary', () => {
  assert.deepEqual(measureArtifactContentSizeV1({ left: 0, top: 0 }, [candidate({ right: 80.1, bottom: 20_000, scrollWidth: 80, scrollHeight: 20_000 })]), { width: 81, height: 16_384 });
  assert.deepEqual(measureArtifactContentSizeV1({ left: 100, top: 100 }, [candidate({ left: 0, top: 0, right: -1, bottom: -1, scrollWidth: 0, scrollHeight: 0 })]), { width: 1, height: 1 });
});
