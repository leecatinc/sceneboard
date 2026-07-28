import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import sharp from 'sharp';

import { loadMediaNativeCertificationEvidence } from '../../src/media/media-native-certification.js';

test('loads the pinned current-platform native decoder from exact golden evidence', async () => {
  const evidence = loadMediaNativeCertificationEvidence();
  assert.notEqual(evidence, null);
  assert.equal(evidence?.ready, true);
  assert.equal(evidence?.sharpVersion, '0.35.3');
  assert.equal(evidence?.libvipsVersion, sharp.versions.vips);
  const certificate = JSON.parse(
    await readFile(
      new URL('../../../test/certification/media-native-certification.v1.json', import.meta.url),
      'utf8',
    ),
  ) as {
    verdict: string;
    platforms: Array<{ cpu: string; verdict: string }>;
    goldenResults: Array<{ id: string; verdict: string }>;
  };
  assert.equal(certificate.verdict, 'PASS');
  assert.deepEqual(
    certificate.platforms.map(({ cpu, verdict }) => [cpu, verdict]),
    [
      ['x64', 'PASS'],
      ['arm64', 'PASS'],
    ],
  );
  assert.deepEqual(
    certificate.goldenResults.map(({ id, verdict }) => [id, verdict]),
    [
      ['png', 'PASS'],
      ['jpeg', 'PASS'],
      ['webp', 'PASS'],
    ],
  );
});
