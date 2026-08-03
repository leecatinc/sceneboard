import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createRestoreCertificationEnvironment,
  validateRestoreLiveReport,
} from '../../scripts/certify-ai-export-contracts.mjs';
import { canonicalJson } from '../../scripts/lib/certification/canonical-json.mjs';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

const root = new URL('../../', import.meta.url);

test('forward-only D3/D7/D8/D9/D10 migrations expose no automatic destructive rollback', async () => {
  const registry = await readFile(
    new URL('sceneboard-be/src/database/migrations/registry.ts', root),
    'utf8',
  );
  const forwardOnly = [
    ...registry.matchAll(
      /version: '([^']+)'[\s\S]*?upAsset: '([^']+)'[\s\S]*?reversible: false,[\s\S]*?downAsset: null/gu,
    ),
  ];
  assert.equal(forwardOnly.length, 29);
  for (const [, , asset] of forwardOnly) {
    const sql = await readFile(
      new URL(`sceneboard-be/src/database/migrations/sql/${asset}`, root),
      'utf8',
    );
    assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE)\b/iu);
  }
});

test('restore drill certifies exact quarantined media bytes with a purpose-separated signature', async () => {
  const script = await readFile(
    new URL('scripts/sceneboard-retention-restore-drill.mjs', root),
    'utf8',
  );
  assert.ok(script.includes('CREATE TABLE ${quarantineSchemaSql}.media_objects LIKE'));
  assert.ok(script.includes('timingSafeEqual(restoredRows[0].bytes, fixtureBytes)'));
  assert.ok(script.includes('audit-media-backup-certificate/v1'));
  assert.ok(script.includes('INSERT INTO media_backup_certificate_objects'));
  assert.doesNotMatch(script, /--evidence-stdin/u);
});

test('restore evidence is producer-derived, current-attempt bound, and cleanup closed', () => {
  const attemptId = 'restore-evidence-attempt';
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const certifiedAt = new Date();
  const evidence = {
    schemaVersion: 2,
    attemptId,
    deploymentId: `cert-${digest(attemptId).slice(0, 24)}`,
    attemptSeq: 1,
    sourceSchemaSha256: digest(
      `sceneboard_cert_${digest(`${attemptId}.restore.source`).slice(0, 20)}`,
    ),
    sourceOwnerSha256: digest(`sceneboard-certification-restore:${attemptId}:source`),
    quarantineSchemaSha256: digest(
      `sceneboard_cert_${digest(`${attemptId}.restore.quarantine`).slice(0, 20)}`,
    ),
    quarantineOwnerSha256: digest(`sceneboard-certification-restore:${attemptId}:quarantine`),
    operatorPrincipalSha256: '1'.repeat(64),
    startedAt: new Date(certifiedAt.getTime() - 2_000).toISOString(),
    restoredAt: new Date(certifiedAt.getTime() - 1_000).toISOString(),
    certifiedAt: certifiedAt.toISOString(),
    expiresAt: new Date(certifiedAt.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    sourceBackupSha256: '2'.repeat(64),
    registrySha256: '6'.repeat(64),
    mediaManifestSha256: '3'.repeat(64),
    schemaProjectionSha256: '4'.repeat(64),
    integritySha256: '5'.repeat(64),
    cleanupStatus: 'PASS',
  };
  const report = {
    ...evidence,
    evidenceSha256: digest(canonicalJson(evidence)),
    status: 'PASS',
  };
  assert.deepEqual(validateRestoreLiveReport(canonicalJson(report), attemptId), report);
  for (const mutation of [
    { attemptId: 'cross-attempt' },
    { cleanupStatus: 'BLOCKED' },
    { schemaProjectionSha256: '0'.repeat(64) },
  ]) {
    const altered = { ...report, ...mutation };
    assert.throws(
      () => validateRestoreLiveReport(canonicalJson(altered), attemptId),
      (error) => error?.code === 'RESTORE_LIVE_EVIDENCE_INVALID',
    );
  }
  assert.throws(
    () =>
      createRestoreCertificationEnvironment(attemptId, {
        APP_ENV: 'test',
        NODE_ENV: 'test',
        MYSQL_HOST: 'database.example.test',
      }),
    (error) => error?.code === 'CERTIFICATION_ENVIRONMENT_UNSAFE',
  );
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
