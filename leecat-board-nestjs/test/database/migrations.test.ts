import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MigrationStateError, assessMigrationLedger } from '../../src/database/migrations/runner.js';

const expected = [
  { version: '001_alpha', checksumHex: 'a'.repeat(64) },
  { version: '002_beta', checksumHex: 'b'.repeat(64) },
];

test('classifies empty, restart-partial, and exact migration ledgers', () => {
  assert.deepEqual(assessMigrationLedger(expected, []), {
    state: 'empty',
    pendingVersions: ['001_alpha', '002_beta'],
  });
  assert.deepEqual(assessMigrationLedger(expected, [expected[0]!]), {
    state: 'partial',
    pendingVersions: ['002_beta'],
  });
  assert.deepEqual(assessMigrationLedger(expected, expected), {
    state: 'complete',
    pendingVersions: [],
  });
});

test('rejects checksum drift, holes, reordered rows, and unknown versions', () => {
  const invalid = [
    [{ version: '001_alpha', checksumHex: 'c'.repeat(64) }],
    [expected[1]!],
    [expected[1]!, expected[0]!],
    [...expected, { version: '003_unknown', checksumHex: 'c'.repeat(64) }],
  ];
  for (const ledger of invalid) assert.throws(() => assessMigrationLedger(expected, ledger), MigrationStateError);
});
