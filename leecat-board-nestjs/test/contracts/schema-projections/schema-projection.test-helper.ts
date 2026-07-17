import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MIGRATION_REGISTRY } from '../../../src/database/migrations/registry.js';

const root = new URL('../../../', import.meta.url);
const schemaPath = 'test/contracts/schema-projections/expected-schema.v1.schema.json';
const sqlRoot = 'src/database/migrations/sql/';

interface ProjectionEntryV1 {
  order: number;
  version: string;
  upAsset: string;
  upSha256: string;
  downAsset: string | null;
  downSha256: string | null;
  reversible: boolean;
  predecessorIds: string[];
}

interface ProjectionTableV1 {
  name: string;
  sourceAsset: string;
  sourceSha256: string;
}

export interface OwnerProjectionV1 {
  schemaVersion: 1;
  owner: 'D2' | 'D3' | 'D7' | 'D8';
  contractSha256: string;
  registryEntries: ProjectionEntryV1[];
  tables: ProjectionTableV1[];
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const read = (path: string): Buffer => readFileSync(new URL(path, root));

const tableNames = (asset: string): string[] => {
  const source = read(`${sqlRoot}${asset}`).toString('utf8');
  return [...source.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z][a-z0-9_]*)\s*\(/gu)]
    .map((match) => match[1] as string);
};

export const readOwnerProjection = (owner: OwnerProjectionV1['owner']): OwnerProjectionV1 => JSON.parse(
  read(`test/contracts/schema-projections/${owner.toLowerCase()}.expected-schema.v1.json`).toString('utf8'),
) as OwnerProjectionV1;

export const assertOwnerProjection = (owner: OwnerProjectionV1['owner']): OwnerProjectionV1 => {
  const projection = readOwnerProjection(owner);
  const contractSha256 = sha256(read(schemaPath));
  assert.deepEqual(Object.keys(projection).sort(), [
    'contractSha256', 'owner', 'registryEntries', 'schemaVersion', 'tables',
  ]);
  assert.equal(projection.schemaVersion, 1);
  assert.equal(projection.owner, owner);
  assert.equal(projection.contractSha256, contractSha256);
  for (const entry of projection.registryEntries) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'downAsset', 'downSha256', 'order', 'predecessorIds', 'reversible', 'upAsset', 'upSha256', 'version',
    ]);
    const actual = MIGRATION_REGISTRY[entry.order - 1];
    assert.ok(actual);
    assert.equal(entry.version, actual.version);
    assert.equal(entry.upAsset, actual.upAsset);
    assert.equal(entry.downAsset, actual.downAsset);
    assert.equal(entry.reversible, actual.reversible);
    assert.equal(entry.upSha256, sha256(read(`${sqlRoot}${entry.upAsset}`)));
    assert.equal(
      entry.downSha256,
      entry.downAsset === null ? null : sha256(read(`${sqlRoot}${entry.downAsset}`)),
    );
    assert.deepEqual(entry.predecessorIds, entry.order === 1 ? [] : [MIGRATION_REGISTRY[entry.order - 2]?.version]);
  }
  const expectedTables = projection.registryEntries.flatMap(({ upAsset, upSha256 }) => (
    tableNames(upAsset).map((name) => ({ name, sourceAsset: upAsset, sourceSha256: upSha256 }))
  ));
  assert.deepEqual(projection.tables, expectedTables);
  return projection;
};

export const projectionAggregateSha256 = (projections: OwnerProjectionV1[]): string => {
  const hash = createHash('sha256');
  for (const bytes of [read(schemaPath), ...projections.map(({ owner }) => (
    read(`test/contracts/schema-projections/${owner.toLowerCase()}.expected-schema.v1.json`)
  ))]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
};
