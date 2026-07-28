import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

const root = new URL('../../', import.meta.url);

test('forward-only D3/D7/D8/D9 migrations expose no automatic destructive rollback', async () => {
  const registry = await readFile(
    new URL('sceneboard-be/src/database/migrations/registry.ts', root),
    'utf8',
  );
  const forwardOnly = [
    ...registry.matchAll(
      /version: '([^']+)'[\s\S]*?upAsset: '([^']+)'[\s\S]*?reversible: false,[\s\S]*?downAsset: null/gu,
    ),
  ];
  assert.equal(forwardOnly.length, 13);
  for (const [, , asset] of forwardOnly) {
    const sql = await readFile(
      new URL(`sceneboard-be/src/database/migrations/sql/${asset}`, root),
      'utf8',
    );
    assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE)\b/iu);
  }
});

test('restore is quarantine-only and production targeting is rejected', () => {
  assert.deepEqual(parseCertificationArguments(['--phase=restore', '--profile=quarantine']), {
    phase: 'restore',
    profile: 'quarantine',
  });
  assert.throws(
    () => parseCertificationArguments(['--phase=restore', '--profile=production']),
    (error) => error?.code === 'CERTIFICATION_ARGUMENT_INVALID',
  );
});
