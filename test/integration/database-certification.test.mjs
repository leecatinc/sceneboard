import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

const root = new URL('../../', import.meta.url);
const projectionNames = ['d2', 'd3', 'd7', 'd8'];
const projectionRoot = new URL('sceneboard-be/test/contracts/schema-projections/', root);

test('owner projections bind one schema and cover the exact 20-entry/23-asset registry', async () => {
  const schemaBytes = await readFile(new URL('expected-schema.v1.schema.json', projectionRoot));
  const schemaSha256 = createHash('sha256').update(schemaBytes).digest('hex');
  const projections = await Promise.all(
    projectionNames.map(async (owner) =>
      JSON.parse(
        await readFile(new URL(`${owner}.expected-schema.v1.json`, projectionRoot), 'utf8'),
      ),
    ),
  );
  assert.deepEqual(
    projections.map(({ owner }) => owner),
    ['D2', 'D3', 'D7', 'D8'],
  );
  for (const projection of projections) assert.equal(projection.contractSha256, schemaSha256);
  const entries = projections
    .flatMap(({ owner, registryEntries }) => registryEntries.map((entry) => ({ owner, ...entry })))
    .sort((left, right) => left.order - right.order);
  assert.deepEqual(
    entries.map(({ order }) => order),
    [...Array.from({ length: 15 }, (_, index) => index + 1), 27, 28, 29, 30, 31],
  );
  assert.equal(new Set(entries.map(({ version }) => version)).size, 20);
  assert.equal(entries.length + entries.filter(({ downAsset }) => downAsset !== null).length, 23);
  for (const entry of entries) {
    const upBytes = await readFile(
      new URL(`sceneboard-be/src/database/migrations/sql/${entry.upAsset}`, root),
    );
    assert.equal(createHash('sha256').update(upBytes).digest('hex'), entry.upSha256);
    if (entry.downAsset !== null) {
      const downBytes = await readFile(
        new URL(`sceneboard-be/src/database/migrations/sql/${entry.downAsset}`, root),
      );
      assert.equal(createHash('sha256').update(downBytes).digest('hex'), entry.downSha256);
    }
  }
});

test('database certification CLI admits only the frozen modes and scenarios', () => {
  assert.deepEqual(
    parseCertificationArguments(['--phase=database', '--mode=full-offline', '--scenario=fresh']),
    {
      phase: 'database',
      mode: 'full-offline',
      scenario: 'fresh',
    },
  );
  assert.deepEqual(parseCertificationArguments(['--phase=database', '--mode=bounded-restart']), {
    phase: 'database',
    mode: 'bounded-restart',
  });
  assert.throws(
    () =>
      parseCertificationArguments([
        '--phase=database',
        '--mode=full-offline',
        '--scenario=production',
      ]),
    (error) => error?.code === 'CERTIFICATION_ARGUMENT_INVALID',
  );
});
