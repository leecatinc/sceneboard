import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactPointerAnchorV1,
  encodeArtifactCoordinateMillionthV1,
  normalizeArtifactWheelDeltaV1,
} from '../src/bridge/index.js';

test('normalizes fractional wheel sign, modes, fallback, zero, and clamp exactly', () => {
  assert.equal(normalizeArtifactWheelDeltaV1(-0.25, 0, 900), -0.25);
  assert.equal(normalizeArtifactWheelDeltaV1(0.25, 1, 900), 4);
  assert.equal(normalizeArtifactWheelDeltaV1(-2, 2, 900), -1_800);
  assert.equal(normalizeArtifactWheelDeltaV1(2, 2, Number.NaN), 1_350);
  assert.equal(normalizeArtifactWheelDeltaV1(0, 0, 900), null);
  assert.equal(normalizeArtifactWheelDeltaV1(Number.NaN, 0, 900), null);
  assert.equal(normalizeArtifactWheelDeltaV1(20_000, 0, 900), 16_384);
  assert.equal(normalizeArtifactWheelDeltaV1(-20_000, 0, 900), -16_384);
});

test('encodes negative, half-step, edge, over-edge, fallback, and large extents exactly', () => {
  assert.equal(encodeArtifactCoordinateMillionthV1(-1, 1_200, 1_200), 0);
  assert.equal(encodeArtifactCoordinateMillionthV1(0, 1_200, 1_200), 0);
  assert.equal(encodeArtifactCoordinateMillionthV1(0.0006, 1_200, 1_200), 1);
  assert.equal(encodeArtifactCoordinateMillionthV1(600, 1_200, 1_200), 500_000);
  assert.equal(encodeArtifactCoordinateMillionthV1(1_200, 1_200, 1_200), 1_000_000);
  assert.equal(encodeArtifactCoordinateMillionthV1(1_201, 1_200, 1_200), 1_000_000);
  assert.deepEqual(artifactPointerAnchorV1(600, 337.5, Number.NaN, 0), {
    xMillionth: 500_000,
    yMillionth: 500_000,
  });
  assert.equal(encodeArtifactCoordinateMillionthV1(5_000_000_000, 10_000_000_000, 1_200), 500_000);
});

test('round-trip normalization stays within half a millionth of the physical extent', () => {
  for (const [coordinate, extent] of [
    [1 / 3, 1],
    [123.456, 1_200],
    [9_999_999.25, 20_000_000],
  ] as const) {
    const encoded = encodeArtifactCoordinateMillionthV1(coordinate, extent, 1_200);
    const decoded = (encoded / 1_000_000) * extent;
    assert.ok(Math.abs(decoded - coordinate) <= extent / 2_000_000);
    assert.ok(Math.abs(encoded / 1_000_000 - decoded / extent) <= 1e-9);
  }
});
