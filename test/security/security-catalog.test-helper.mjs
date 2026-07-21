import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateSecurityCatalog } from '../../scripts/lib/certification/security-catalog.mjs';

const catalog = JSON.parse(
  await readFile(
    new URL('../certification/security-case-catalog.v1.json', import.meta.url),
    'utf8',
  ),
);

export const registerLiveGatedCatalogRows = async ({ testFile, clusters, expectedCounts }) => {
  const result = await validateSecurityCatalog(catalog);
  assert.equal(result.status, 'PASS');
  assert.equal(result.liveEvidenceStatus, 'BLOCKED');
  const rows = catalog.cases.filter((row) => clusters.includes(row.cluster));
  const expectedTotal = Object.values(expectedCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(rows.length, expectedTotal);
  for (const [cluster, count] of Object.entries(expectedCounts)) {
    assert.equal(rows.filter((row) => row.cluster === cluster).length, count);
  }
  for (const row of rows) {
    test(`catalog registration (live BLOCKED): ${row.caseId}`, () => {
      assert.equal(row.testFile, testFile);
      assert.equal(row.evidenceClass, 'live-required');
      assert.equal(row.evidenceRowId, `SEC-${row.caseId}`);
      assert.equal(row.cleanupAssertion, 'exact-owned-fixture-clean');
      assert.match(row.upstreamFixtureSha256, /^[0-9a-f]{64}$/u);
    });
  }
};
