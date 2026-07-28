import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMigrationCliArguments, runMigrationCli } from '../../src/database/migrations/cli.js';

const state = {
  mode: 'restart',
  registryVersion: '015_d9_revision_retention_runtime',
  connectionProfile: {
    databaseIdentitySha256: 'a'.repeat(64),
    serverVersion: '8.0.40',
    timeZone: '+00:00',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    sqlModeSha256: 'b'.repeat(64),
  },
} as const;

test('parses only exact status, up, and ordered adoption grammar', () => {
  assert.deepEqual(parseMigrationCliArguments(['status']), { command: 'status' });
  assert.deepEqual(parseMigrationCliArguments(['up']), { command: 'up' });
  assert.deepEqual(
    parseMigrationCliArguments([
      'adopt',
      '--version',
      state.registryVersion,
      '--incident-ref',
      'INC-2026-07-17',
    ]),
    {
      command: 'adopt',
      version: state.registryVersion,
      incidentRef: 'INC-2026-07-17',
    },
  );
  for (const argv of [
    [],
    ['status', '--extra'],
    ['up', '--force'],
    ['adopt', '--incident-ref', 'INC', '--version', state.registryVersion],
    ['adopt', '--version', state.registryVersion, '--incident-ref', 'bad\nref'],
    ['adopt', '--version', state.registryVersion, '--incident-ref'],
  ])
    assert.throws(() => parseMigrationCliArguments(argv));
});

test('does not report migration success before the injected certification callback succeeds', async () => {
  const calls: string[] = [];
  const runner = {
    status: async () => {
      calls.push('runner.status');
      return state;
    },
    up: async () => {
      calls.push('runner.up');
      return state;
    },
    adopt: async () => {
      calls.push('runner.adopt');
      return { ...state, mode: 'adopt' as const };
    },
  };
  const passed = await runMigrationCli(['up'], runner, async (caller, received) => {
    calls.push(`certify:${caller}:${received.mode}`);
    return { status: 'succeeded' };
  });
  assert.deepEqual(passed, { status: 'succeeded', caller: 'db:migrate:up', exitCode: 0 });
  assert.deepEqual(calls, ['runner.up', 'certify:db:migrate:up:restart']);

  const denied = await runMigrationCli(['status'], runner, async () => ({ status: 'failed' }));
  assert.deepEqual(denied, { status: 'failed', code: 'MIGRATION_COMMAND_FAILED', exitCode: 1 });
  const invalid = await runMigrationCli(['status', '--force'], runner, async () => ({
    status: 'succeeded',
  }));
  assert.deepEqual(invalid, { status: 'failed', code: 'MIGRATION_COMMAND_FAILED', exitCode: 1 });
});
