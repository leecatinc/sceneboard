import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { SqlSplitError, splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

test('splits deterministic MySQL statements without splitting quoted semicolons', () => {
  const source = `
    -- schema comment
    CREATE TABLE sample (id BIGINT PRIMARY KEY, note VARCHAR(100));
    INSERT INTO sample (id, note) VALUES (1, 'semi;colon');
    /* block ; comment */
    UPDATE sample SET note = "double;quoted" WHERE id = 1;
    SELECT \`semi;identifier\` FROM sample;
  `;
  assert.deepEqual(splitSqlStatements(source), [
    'CREATE TABLE sample (id BIGINT PRIMARY KEY, note VARCHAR(100))',
    "INSERT INTO sample (id, note) VALUES (1, 'semi;colon')",
    'UPDATE sample SET note = "double;quoted" WHERE id = 1',
    'SELECT `semi;identifier` FROM sample',
  ]);
});

test('rejects empty, unterminated, delimiter-changing, executable-comment, and NUL scripts', () => {
  for (const source of [
    '',
    "SELECT 'unterminated;",
    'DELIMITER $$\nSELECT 1$$',
    '/*!40101 SET @x = 1 */;',
    'SELECT \0;',
  ]) {
    assert.throws(() => splitSqlStatements(source), SqlSplitError, source);
  }
  assert.deepEqual(splitSqlStatements('SELECT 1'), ['SELECT 1']);
});

test('freezes the exact terminal D2/D3/D7/D8/D9 checkpoint order and reversibility', () => {
  assert.deepEqual(MIGRATION_REGISTRY, [
    {
      version: '001_d2_identity_sessions_audit',
      upAsset: '001_d2_identity_sessions_audit.up.sql',
      reversible: true,
      downAsset: '001_d2_identity_sessions_audit.down.sql',
      postcondition: 'd2_identity_sessions_audit_v1',
    },
    {
      version: '001_d3_boards',
      upAsset: '001_d3_boards.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd3_boards_v1',
    },
    {
      version: '002_d2_pairing_grants',
      upAsset: '002_d2_pairing_grants.up.sql',
      reversible: true,
      downAsset: '002_d2_pairing_grants.down.sql',
      postcondition: 'd2_pairing_grants_v1',
    },
    {
      version: '002_d3_board_revisions',
      upAsset: '002_d3_board_revisions.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd3_board_revisions_v1',
    },
    {
      version: '003_d3_board_heads',
      upAsset: '003_d3_board_heads.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd3_board_heads_v1',
    },
    {
      version: '004_d3_board_idempotency_records',
      upAsset: '004_d3_board_idempotency_records.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd3_board_idempotency_records_v1',
    },
    {
      version: '005_d3_board_revision_artifact_refs',
      upAsset: '005_d3_board_revision_artifact_refs.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd3_board_revision_artifact_refs_v1',
    },
    {
      version: '006_d3_board_event_outbox',
      upAsset: '006_d3_board_event_outbox.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd3_board_event_outbox_v1',
    },
    {
      version: '003_d2_artifact_capability_policy',
      upAsset: '003_d2_artifact_capability_policy.up.sql',
      reversible: true,
      downAsset: '003_d2_artifact_capability_policy.down.sql',
      postcondition: 'd2_artifact_capability_policy_v1',
    },
    {
      version: '007_d7_artifacts',
      upAsset: '007_d7_artifacts.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd7_artifacts_v1',
    },
    {
      version: '008_d7_artifact_versions',
      upAsset: '008_d7_artifact_versions.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd7_artifact_versions_v1',
    },
    {
      version: '009_d7_artifact_resources',
      upAsset: '009_d7_artifact_resources.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd7_artifact_resources_v1',
    },
    {
      version: '010_d7_artifact_runtime_states',
      upAsset: '010_d7_artifact_runtime_states.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd7_artifact_runtime_states_v1',
    },
    {
      version: '011_d7_artifact_board_usage',
      upAsset: '011_d7_artifact_board_usage.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd7_artifact_board_usage_v1',
    },
    {
      version: '012_d8_board_hitl_interactions',
      upAsset: '012_d8_board_hitl_interactions.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd8_board_hitl_interactions_v1',
    },
    {
      version: '013_d9_v2_checkpoint_capacity',
      upAsset: '013_d9_v2_checkpoint_capacity.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_v2_checkpoint_capacity_v1',
    },
    {
      version: '014_d9_revision_retention_expand',
      upAsset: '014_d9_revision_retention_expand.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_revision_retention_expand_v1',
    },
    {
      version: '015_d9_revision_retention_runtime',
      upAsset: '015_d9_revision_retention_runtime.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_revision_retention_runtime_v1',
    },
    {
      version: '016_d9_board_memberships',
      upAsset: '016_d9_board_memberships.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_board_memberships_v1',
    },
    {
      version: '017_d9_board_invitations',
      upAsset: '017_d9_board_invitations.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_board_invitations_v1',
    },
    {
      version: '018_d9_board_revision_media_refs',
      upAsset: '018_d9_board_revision_media_refs.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_board_revision_media_refs_v1',
    },
    {
      version: '019_d9_board_shares',
      upAsset: '019_d9_board_shares.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_board_shares_v1',
    },
    {
      version: '020_d9_share_password_auth',
      upAsset: '020_d9_share_password_auth.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_share_password_auth_v1',
    },
    {
      version: '021_d9_media_store',
      upAsset: '021_d9_media_store.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_media_store_v1',
    },
    {
      version: '022_d9_media_retention_recovery',
      upAsset: '022_d9_media_retention_recovery.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_media_retention_recovery_v1',
    },
  ]);
});
