import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCertificationDispatch,
} from '../../src/bootstrap/persistence-certification.bootstrap.js';
import type { CertificationDispatchV1 } from '../../src/bootstrap/persistence-certification.types.js';
import type { MigrationCertificationStateV1 } from '../../src/database/migrations/certification-state.js';

const profile = {
  databaseIdentitySha256: 'a'.repeat(64),
  serverVersion: '8.0.40',
  timeZone: '+00:00',
  characterSet: 'utf8mb4',
  collation: 'utf8mb4_0900_ai_ci',
  sqlModeSha256: 'b'.repeat(64),
} as const;

const fresh = { mode: 'fresh', registryVersion: '012_d8_board_hitl_interactions', connectionProfile: profile } satisfies MigrationCertificationStateV1;
const adopt = { ...fresh, mode: 'adopt' } satisfies MigrationCertificationStateV1;
const restart = { ...fresh, mode: 'restart' } satisfies MigrationCertificationStateV1;

const allowed = [
  { ...fresh, stateMode: 'fresh', caller: 'db:migrate:up', certificationMode: 'FULL_OFFLINE', successAction: 'CLI_EXIT_0_LISTENERS_STOPPED', authorizesListener: false },
  { ...restart, stateMode: 'restart', caller: 'db:migrate:up', certificationMode: 'FULL_OFFLINE', successAction: 'CLI_EXIT_0_LISTENERS_STOPPED', authorizesListener: false },
  { ...adopt, stateMode: 'adopt', caller: 'db:migrate:adopt', certificationMode: 'FULL_OFFLINE', successAction: 'CLI_EXIT_0_LISTENERS_STOPPED', authorizesListener: false },
] satisfies readonly CertificationDispatchV1[];
void allowed;

// @ts-expect-error adoption cannot be certified from a restart state.
const forbidden: CertificationDispatchV1 = { ...restart, stateMode: 'restart', caller: 'db:migrate:adopt', certificationMode: 'FULL_OFFLINE', successAction: 'CLI_EXIT_0_LISTENERS_STOPPED', authorizesListener: false };
void forbidden;

test('maps all six callers to the exact certification mode and exposure authority', () => {
  assert.deepEqual([
    buildCertificationDispatch('db:migrate:up', fresh),
    buildCertificationDispatch('db:migrate:adopt', adopt),
    buildCertificationDispatch('quarantine.restore.promote', restart),
    buildCertificationDispatch('db:migrate:status', restart),
    buildCertificationDispatch('http-mcp.bootstrap', restart),
    buildCertificationDispatch('db:persistence:scan', restart),
  ].map(({ caller, certificationMode, successAction, authorizesListener }) => ({
    caller, certificationMode, successAction, authorizesListener,
  })), [
    { caller: 'db:migrate:up', certificationMode: 'FULL_OFFLINE', successAction: 'CLI_EXIT_0_LISTENERS_STOPPED', authorizesListener: false },
    { caller: 'db:migrate:adopt', certificationMode: 'FULL_OFFLINE', successAction: 'CLI_EXIT_0_LISTENERS_STOPPED', authorizesListener: false },
    { caller: 'quarantine.restore.promote', certificationMode: 'FULL_OFFLINE', successAction: 'WRITE_PROMOTION_EVIDENCE_LISTENERS_STOPPED', authorizesListener: false },
    { caller: 'db:migrate:status', certificationMode: 'BOUNDED_RESTART', successAction: 'CLI_EXIT_0_BOUNDED_REPORT_ONLY', authorizesListener: false },
    { caller: 'http-mcp.bootstrap', certificationMode: 'BOUNDED_RESTART', successAction: 'START_LISTENER', authorizesListener: true },
    { caller: 'db:persistence:scan', certificationMode: 'RESUMABLE_AUDIT', successAction: 'CLI_EXIT_0_OPERATOR_EVIDENCE_ONLY', authorizesListener: false },
  ]);
});

test('rejects every forbidden caller and migration-state pair', () => {
  assert.throws(() => buildCertificationDispatch('db:migrate:adopt', restart));
  assert.throws(() => buildCertificationDispatch('db:migrate:status', fresh));
  assert.throws(() => buildCertificationDispatch('http-mcp.bootstrap', adopt));
  assert.throws(() => buildCertificationDispatch('db:persistence:scan', fresh));
  assert.throws(() => buildCertificationDispatch('quarantine.restore.promote', adopt));
});
