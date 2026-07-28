import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

interface Projection {
  migration: string;
  reversible: boolean;
  tables: string[];
  batchRevisionMaximum: number;
  batchStoredBytesMaximum: number;
  inlinePayloadMembers: string[];
}

const projection = async (): Promise<Projection> =>
  JSON.parse(
    await readFile(
      new URL(
        '../contracts/schema-projections/d9-revision-retention-runtime.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Projection;

test('registers the forward-only retention runtime after expand', async () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-5), {
    version: '015_d9_revision_retention_runtime',
    upAsset: '015_d9_revision_retention_runtime.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_revision_retention_runtime_v1',
  });
  assert.equal(MIGRATION_REGISTRY.at(-6)?.version, '014_d9_revision_retention_expand');
  assert.deepEqual(
    { migration: (await projection()).migration, reversible: (await projection()).reversible },
    { migration: '015_d9_revision_retention_runtime', reversible: false },
  );
});

test('pins lease, fence, batch, runtime ledger, and exact nullable inline tuple', async () => {
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/015_d9_revision_retention_runtime.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const lockServiceSource = await readFile(
    new URL('../../src/revisions/retention/retention-lock.service.ts', import.meta.url),
    'utf8',
  );
  const expected = await projection();
  assert.equal(splitSqlStatements(source).length, 9);
  for (const table of expected.tables) {
    assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`, 'u'));
  }
  assert.match(source, /fence BIGINT UNSIGNED NOT NULL/u);
  assert.match(lockServiceSource, /innodb_lock_wait_timeout = 2/u);
  assert.match(lockServiceSource, /CURRENT_TIMESTAMP\(3\) \+ INTERVAL 60 SECOND/u);
  assert.match(lockServiceSource, /lease_expires_at > CURRENT_TIMESTAMP\(3\)/u);
  assert.match(source, /candidate_count BETWEEN 0 AND 100/u);
  assert.match(source, /stored_bytes BETWEEN 0 AND 33554432/u);
  for (const member of expected.inlinePayloadMembers) {
    assert.match(source, new RegExp(`${member} IS NULL`, 'u'));
    assert.match(
      source,
      member === 'scene_codec'
        ? /scene_codec = 'B'/u
        : member === 'scene_stored_bytes'
          ? /scene_stored_bytes = OCTET_LENGTH\(scene_payload\)/u
          : new RegExp(`${member} IS NOT NULL`, 'u'),
    );
  }
  assert.equal(expected.batchRevisionMaximum, 100);
  assert.equal(expected.batchStoredBytesMaximum, 33_554_432);
});

test('requires latest signed restore evidence with exact 30-day expiry', async () => {
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/015_d9_revision_retention_runtime.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(source, /PRIMARY KEY \(deployment_id, attempt_seq\)/u);
  assert.match(source, /expires_at = certified_at \+ INTERVAL 30 DAY/u);
  assert.match(source, /signature BINARY\(32\) NOT NULL/u);
});
