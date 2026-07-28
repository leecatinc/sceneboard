import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { RevisionPayloadCatalogRepository } from '../../src/revisions/revision-payload-catalog.repository.js';

const bundle = {
  boardPk: '50',
  revisionPk: '70',
  retainedOrder: 3,
  createdAtSql: '2026-07-28 00:00:00.000',
  actorAccountPk: '20',
  actorClass: 'owner' as const,
  checkpoint: {
    schemaVersion: '1.0.0' as const,
    codec: 'B' as const,
    canonicalBytes: 2,
    storedBytes: 2,
    sha256: Buffer.alloc(32, 1),
    payload: Buffer.from('{}'),
  },
};

test('persists detached payload before catalog head movement on one caller connection', async () => {
  const calls: string[] = [];
  const connection = {
    async execute(sql: string): Promise<[ResultSetHeader, unknown]> {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      calls.push(normalized);
      return [
        {
          affectedRows: normalized.startsWith('UPDATE board_revision_catalog') ? 0 : 1,
        } as ResultSetHeader,
        [],
      ];
    },
  } as unknown as PoolConnection;
  await new RevisionPayloadCatalogRepository().persistRevisionBundle(connection, bundle);
  assert.match(calls[0] ?? '', /^INSERT INTO board_revision_payloads/u);
  assert.match(calls[1] ?? '', /^UPDATE board_revision_catalog SET is_head = 0/u);
  assert.match(calls[2] ?? '', /^INSERT INTO board_revision_catalog/u);
});

test('stops the bundle immediately when a derived member fails', async () => {
  let calls = 0;
  const connection = {
    async execute(): Promise<[ResultSetHeader, unknown]> {
      calls += 1;
      if (calls === 2) throw new Error('injected catalog head failure');
      return [{ affectedRows: 1 } as ResultSetHeader, []];
    },
  } as unknown as PoolConnection;
  await assert.rejects(
    new RevisionPayloadCatalogRepository().persistRevisionBundle(connection, bundle),
    /injected catalog head failure/u,
  );
  assert.equal(calls, 2);
});
