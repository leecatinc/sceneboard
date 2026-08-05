import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { passwordDatabaseNow } from '../../src/shares/password-share.repository.js';

test('share flows read the database clock at the supported millisecond precision', async () => {
  let query = '';
  const connection = {
    execute: async (sql: string) => {
      query = sql;
      return [[{ nowSql: '2026-08-04 23:45:12.123' } as RowDataPacket], []];
    },
  } as unknown as PoolConnection;

  assert.equal(await passwordDatabaseNow(connection), '2026-08-04 23:45:12.123');
  assert.equal(query, 'SELECT UTC_TIMESTAMP(3) AS nowSql');
});
