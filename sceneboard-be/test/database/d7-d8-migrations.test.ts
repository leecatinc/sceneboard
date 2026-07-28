import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const directory = new URL('../../src/database/migrations/sql/', import.meta.url);

test('serializes D7 007-011 and D8 012 as six forward-only single-table migrations', async () => {
  const terminal = MIGRATION_REGISTRY.filter((entry) =>
    /^(?:007|008|009|010|011)_d7_|^012_d8_/u.test(entry.version),
  );
  assert.equal(terminal.length, 6);
  assert.equal(
    terminal.every((entry) => !entry.reversible && entry.downAsset === null),
    true,
  );
  for (const entry of terminal) {
    const source = await readFile(new URL(entry.upAsset, directory), 'utf8');
    assert.equal(splitSqlStatements(source).length, 1, entry.version);
    assert.equal((source.match(/CREATE TABLE /gu) ?? []).length, 1, entry.version);
  }
});

test('keeps D7 immutable aggregates and D8 interaction chronology fail closed', async () => {
  const resources = await readFile(new URL('009_d7_artifact_resources.up.sql', directory), 'utf8');
  assert.match(resources, /resource_bytes = OCTET_LENGTH\(resource_payload\)/u);
  assert.match(resources, /resource_path VARBINARY\(1024\) NOT NULL/u);
  assert.doesNotMatch(resources, /resource_path VARCHAR\(1024\)/u);
  assert.match(resources, /ON DELETE RESTRICT/u);
  const runtime = await readFile(
    new URL('010_d7_artifact_runtime_states.up.sql', directory),
    'utf8',
  );
  assert.match(runtime, /status_code IN \('R','S','F','B'\)/u);
  const interactions = await readFile(
    new URL('012_d8_board_hitl_interactions.up.sql', directory),
    'utf8',
  );
  assert.match(interactions, /UNIQUE KEY uq_hitl_board_request/u);
  assert.match(interactions, /state_updated_at = expires_at/u);
  assert.match(interactions, /response_canonical_bytes BETWEEN 1 AND 65536/u);
});
