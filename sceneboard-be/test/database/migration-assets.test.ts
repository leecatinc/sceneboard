import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

test('binds every staged registry asset to non-empty deterministic SQL', async () => {
  const directory = new URL('../../src/database/migrations/sql/', import.meta.url);
  const assets = new Set<string>();
  for (const entry of MIGRATION_REGISTRY) {
    assets.add(entry.upAsset);
    if (entry.downAsset !== null) assets.add(entry.downAsset);
  }
  assert.equal(assets.size, 28);
  for (const asset of assets) {
    const bytes = await readFile(new URL(asset, directory));
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.ok(splitSqlStatements(source).length > 0, asset);
  }
});

test('interleaves the irreversible D3 board owner before D2 grant bindings', async () => {
  assert.deepEqual(
    MIGRATION_REGISTRY.slice(0, 9).map((entry) => entry.version),
    [
      '001_d2_identity_sessions_audit',
      '001_d3_boards',
      '002_d2_pairing_grants',
      '002_d3_board_revisions',
      '003_d3_board_heads',
      '004_d3_board_idempotency_records',
      '005_d3_board_revision_artifact_refs',
      '006_d3_board_event_outbox',
      '003_d2_artifact_capability_policy',
    ],
  );
  const board = MIGRATION_REGISTRY[1];
  assert.equal(board?.reversible, false);
  assert.equal(board?.downAsset, null);
  const source = await readFile(
    new URL('../../src/database/migrations/sql/001_d3_boards.up.sql', import.meta.url),
    'utf8',
  );
  assert.equal(splitSqlStatements(source).length, 1);
  assert.match(source, /CONSTRAINT fk_boards_owner_user FOREIGN KEY \(owner_user_id\)/);
  assert.doesNotMatch(source, /CONSTRAINT\s+(?:chk|ck)_boards_public_id/);
  assert.doesNotMatch(source, /REGEXP_LIKE\s*\(\s*public_id/);
});

test('materializes the exact terminal twenty-four-entry and twenty-seven-asset checkpoint', async () => {
  assert.equal(MIGRATION_REGISTRY.length, 25);
  assert.equal(MIGRATION_REGISTRY.filter((entry) => entry.reversible).length, 3);
  const directory = new URL('../../src/database/migrations/sql/', import.meta.url);
  const expectedTables = new Map([
    ['002_d3_board_revisions.up.sql', ['board_revisions']],
    ['003_d3_board_heads.up.sql', ['board_heads']],
    ['004_d3_board_idempotency_records.up.sql', ['board_idempotency_records']],
    ['005_d3_board_revision_artifact_refs.up.sql', ['board_revision_artifact_refs']],
    ['006_d3_board_event_outbox.up.sql', ['board_event_outbox']],
    [
      '003_d2_artifact_capability_policy.up.sql',
      [
        'board_artifact_capability_policy_epochs',
        'board_artifact_capability_policies',
        'artifact_capability_preauthorization_tickets',
      ],
    ],
    ['007_d7_artifacts.up.sql', ['artifacts']],
    ['008_d7_artifact_versions.up.sql', ['artifact_versions']],
    ['009_d7_artifact_resources.up.sql', ['artifact_resources']],
    ['010_d7_artifact_runtime_states.up.sql', ['artifact_runtime_states']],
    ['011_d7_artifact_board_usage.up.sql', ['artifact_board_usage']],
    ['012_d8_board_hitl_interactions.up.sql', ['board_hitl_interactions']],
    ['018_d9_board_revision_media_refs.up.sql', ['board_revision_media_refs']],
    [
      '014_d9_revision_retention_expand.up.sql',
      [
        'board_revision_payloads',
        'board_revision_catalog',
        'board_revision_holds',
        'board_revision_recovery',
      ],
    ],
  ]);
  for (const [asset, tables] of expectedTables) {
    const source = await readFile(new URL(asset, directory), 'utf8');
    assert.equal(splitSqlStatements(source).length, tables.length, asset);
    for (const table of tables)
      assert.match(source, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table} \\(`));
  }
  const revisions = await readFile(new URL('002_d3_board_revisions.up.sql', directory), 'utf8');
  assert.match(revisions, /UNIQUE KEY uq_revisions_board_pk \(board_pk, revision_pk\)/);
  assert.match(
    revisions,
    /FOREIGN KEY \(board_pk, previous_revision_pk\)\s+REFERENCES board_revisions \(board_pk, revision_pk\)/,
  );
  const references = await readFile(
    new URL('005_d3_board_revision_artifact_refs.up.sql', directory),
    'utf8',
  );
  assert.doesNotMatch(references, /REFERENCES artifacts/u);
  const capacity = await readFile(
    new URL('013_d9_v2_checkpoint_capacity.up.sql', directory),
    'utf8',
  );
  assert.equal(splitSqlStatements(capacity).length, 1);
  assert.match(capacity, /MODIFY COLUMN scene_payload LONGBLOB NOT NULL/u);
  assert.match(capacity, /MODIFY COLUMN scene_canonical_bytes INT UNSIGNED NOT NULL/u);
  assert.match(capacity, /scene_schema_version = '2\.0\.0'/u);
  const retentionRuntime = await readFile(
    new URL('015_d9_revision_retention_runtime.up.sql', directory),
    'utf8',
  );
  assert.equal(splitSqlStatements(retentionRuntime).length, 9);
  for (const table of [
    'board_retention_leases',
    'board_retention_runs',
    'board_retention_run_items',
    'board_retention_audit',
    'retention_restore_drill_attempts',
  ]) {
    assert.match(retentionRuntime, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`, 'u'));
  }
  assert.match(retentionRuntime, /ADD COLUMN actor_account_pk BIGINT UNSIGNED NULL/u);
  assert.match(
    retentionRuntime,
    /MODIFY COLUMN actor_class ENUM\('owner','editor','system'\) NOT NULL/u,
  );
  assert.match(retentionRuntime, /CONSTRAINT chk_revisions_retained_checkpoint/u);
  const memberships = await readFile(new URL('016_d9_board_memberships.up.sql', directory), 'utf8');
  assert.equal(splitSqlStatements(memberships).length, 2);
  assert.match(memberships, /UNIQUE KEY uq_board_memberships_account \(board_pk, account_pk\)/u);
  assert.match(memberships, /CONSTRAINT chk_board_memberships_owner_projection/u);
});

test('the live runner verifies every terminal D7, D8, and D9 migration postcondition', async () => {
  const source = await readFile(
    new URL('../../src/database/migrations/runner.ts', import.meta.url),
    'utf8',
  );
  for (const postcondition of [
    'd7_artifacts_v1',
    'd7_artifact_versions_v1',
    'd7_artifact_resources_v1',
    'd7_artifact_runtime_states_v1',
    'd7_artifact_board_usage_v1',
    'd8_board_hitl_interactions_v1',
  ])
    assert.match(source, new RegExp(`${postcondition}:`));
  assert.match(source, /postcondition === 'd9_v2_checkpoint_capacity_v1'/u);
  assert.match(source, /postcondition === 'd9_revision_retention_expand_v1'/u);
  assert.match(source, /d9_revision_retention_runtime_v1:/u);
  assert.match(source, /d9_board_memberships_v1:/u);
});

test('binds D2 pairing and grant tables to the exact D3 public board key', async () => {
  const source = await readFile(
    new URL('../../src/database/migrations/sql/002_d2_pairing_grants.up.sql', import.meta.url),
    'utf8',
  );
  assert.equal(splitSqlStatements(source).length, 5);
  for (const table of [
    'mcp_clients',
    'mcp_grants',
    'pairing_requests',
    'mcp_grant_credentials',
    'mcp_grant_boards',
  ]) {
    assert.match(source, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(source, /CONSTRAINT ck_pairing_state_fields CHECK/);
  assert.match(
    source,
    /CONSTRAINT fk_mcp_grant_boards_board_public_id FOREIGN KEY \(board_public_id\)\s+REFERENCES boards \(public_id\)/,
  );
  assert.match(
    source,
    /CONSTRAINT ck_mcp_grants_masks CHECK \(scope_mask BETWEEN 1 AND 127 AND lifecycle_mask BETWEEN 0 AND 3\)/,
  );
  assert.doesNotMatch(source, /REGEXP_LIKE\s*\(\s*board_public_id/);
});

test('uses the exact compile-then-copy build contract', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.build,
    'tsc -p tsconfig.build.json && tsx scripts/copy-sql-assets.ts',
  );
  const copier = await readFile(
    new URL('../../scripts/copy-sql-assets.ts', import.meta.url),
    'utf8',
  );
  assert.match(copier, /MIGRATION_REGISTRY/);
});
