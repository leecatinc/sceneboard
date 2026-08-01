import assert from 'node:assert/strict';
import test from 'node:test';
import { MIGRATION_REGISTRY } from '../../../src/database/migrations/registry.js';
import {
  assertOwnerProjection,
  projectionAggregateSha256,
} from './schema-projection.test-helper.js';

test('five owner projections bind the shared schema and exact 31-entry 34-asset registry', () => {
  const projections = (['D2', 'D3', 'D7', 'D8', 'D9'] as const).map(assertOwnerProjection);
  const entries = projections
    .flatMap(({ registryEntries }) => registryEntries)
    .sort((left, right) => left.order - right.order);
  assert.deepEqual(
    entries.map(({ version }) => version),
    MIGRATION_REGISTRY.map(({ version }) => version),
  );
  assert.equal(new Set(entries.map(({ order }) => order)).size, 31);
  const assets = entries.flatMap(({ upAsset, downAsset }) =>
    downAsset === null ? [upAsset] : [upAsset, downAsset],
  );
  assert.equal(assets.length, 34);
  assert.equal(new Set(assets).size, 34);
  const tables = projections.flatMap(({ tables }) => tables.map(({ name }) => name));
  assert.equal(tables.length, 60);
  assert.equal(new Set(tables).size, tables.length);
  assert.match(projectionAggregateSha256(projections), /^[0-9a-f]{64}$/u);
});
