import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import { RevisionPayloadCutoverService } from '../../src/revisions/revision-payload-cutover.service.js';

const row = (revisionPk: string, storedBytes: number) => ({
  revisionPk,
  schemaVersion: '2.0.0',
  codec: 'B',
  payload: Buffer.alloc(storedBytes),
  canonicalBytes: storedBytes,
  storedBytes,
  sha256: Buffer.alloc(32, Number(revisionPk)),
});

test('backfill always advances one exact 32 MiB row and remains restartable', async () => {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const connection = {
    async execute(sql: string, binds: unknown[]) {
      calls.push({ sql, binds });
      if (sql.includes('FROM board_revisions')) {
        return [[row('1', 33_554_432), row('2', 1)], []];
      }
      return [{ affectedRows: 1 }, []];
    },
  } as unknown as PoolConnection;
  const report = await new RevisionPayloadCutoverService().backfillBatch(connection, '0');
  assert.deepEqual(report, {
    processed: 1,
    storedBytes: 33_554_432,
    nextRevisionPk: '1',
  });
  assert.match(calls[0]?.sql ?? '', /ORDER BY revision_pk ASC\s+LIMIT 101\s+FOR UPDATE/u);
  assert.deepEqual(calls[0]?.binds, ['0']);
  assert.match(calls[1]?.sql ?? '', /ON DUPLICATE KEY UPDATE revision_pk = VALUES\(revision_pk\)/u);
});

test('inline clear is one six-member parity-guarded update and fails closed on mismatch', async () => {
  const connection = {
    async execute(sql: string) {
      if (sql.includes('FROM board_revisions')) return [[row('7', 8)], []];
      assert.match(
        sql,
        /scene_schema_version = NULL, r\.scene_codec = NULL, r\.scene_payload = NULL/u,
      );
      assert.match(
        sql,
        /scene_canonical_bytes = NULL, r\.scene_stored_bytes = NULL, r\.scene_sha256 = NULL/u,
      );
      return [{ affectedRows: 0 }, []];
    },
  } as unknown as PoolConnection;
  await assert.rejects(
    new RevisionPayloadCutoverService().clearInlineBatch(connection, '6'),
    BoardPersistenceError,
  );
});

test('global parity rejects a missing or byte-mismatched detached payload', async () => {
  for (const [projection, expected] of [
    [{ missingDetached: '0', parityMismatch: '0' }, true],
    [{ missingDetached: '1', parityMismatch: '0' }, false],
    [{ missingDetached: '0', parityMismatch: '1' }, false],
  ] as const) {
    const connection = {
      async execute() {
        return [[projection], []];
      },
    } as unknown as PoolConnection;
    assert.equal(await new RevisionPayloadCutoverService().certifyParity(connection), expected);
  }
});
