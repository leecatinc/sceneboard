import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createMigrationCertificationEnvironment,
  validateDatabaseBoundaryReport,
} from '../../scripts/certify-ai-export-contracts.mjs';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

const root = new URL('../../', import.meta.url);
const projectionNames = ['d2', 'd3', 'd7', 'd8'];
const projectionRoot = new URL('sceneboard-be/test/contracts/schema-projections/', root);

test('owner projections bind one schema and cover the exact 21-entry/24-asset projection slice', async () => {
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
    [...Array.from({ length: 15 }, (_, index) => index + 1), 27, 28, 29, 30, 31, 32],
  );
  assert.equal(new Set(entries.map(({ version }) => version)).size, 21);
  assert.equal(entries.length + entries.filter(({ downAsset }) => downAsset !== null).length, 24);
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

test('migration 027 certification owns a unique schema and adopts the current terminal registry', async () => {
  const script = await readFile(
    new URL('../../scripts/certify-migration-027.mjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /certificationDatabaseName\(fixtureAttemptId\)/u);
  assert.match(script, /certification_fixture_owner/u);
  assert.match(script, /const terminalVersion = registryVersions\.at\(-1\)/u);
  assert.match(script, /'--version',\s*terminalVersion/u);
  assert.doesNotMatch(script, /DROP TABLE/u);
  assert.doesNotMatch(script, /MYSQL_DATABASE !== 'sceneboard'/u);
  assert.match(script, /db:migrate:up/u);
  assert.match(script, /db:migrate:status/u);
  assert.match(script, /db:migrate:adopt/u);
  assert.match(script, /cleanup left residue/u);
  assert.match(script, /verifyResumableAudit/u);
  assert.match(script, /verifyTerminalRegistry/u);
  assert.match(script, /recordScenario\('zero-residue-cleanup'\)/u);
});

test('database boundary accepts only producer-observed exact scenario closure', () => {
  const attemptId = 'database-boundary-attempt';
  const ownerSha256 = createHash('sha256')
    .update(`sceneboard-certification-database:${attemptId}.migration`)
    .digest('hex');
  const report = {
    schemaVersion: 1,
    status: 'PASS',
    target: 'disposable-loopback-mysql',
    databaseOwnerSha256: ownerSha256,
    terminalVersion: '029_d10_export_terminal_audit',
    scenarios: [
      'fresh',
      'bounded-restart',
      'projection',
      'terminal-registry',
      'resumable-audit',
      'adopt',
      'zero-residue-cleanup',
    ],
    cleanupStatus: 'PASS',
  };
  assert.deepEqual(validateDatabaseBoundaryReport(JSON.stringify(report), attemptId), report);
  for (const mutation of [
    { scenarios: report.scenarios.slice(0, -1) },
    { cleanupStatus: 'BLOCKED' },
    { databaseOwnerSha256: '0'.repeat(64) },
  ]) {
    assert.throws(
      () => validateDatabaseBoundaryReport(JSON.stringify({ ...report, ...mutation }), attemptId),
      (error) => error?.code === 'DATABASE_BOUNDARY_EVIDENCE_INVALID',
    );
  }
  assert.throws(
    () =>
      createMigrationCertificationEnvironment(attemptId, {
        MYSQL_HOST: 'database.example.test',
      }),
    (error) => error?.code === 'CERTIFICATION_ENVIRONMENT_UNSAFE',
  );
});
