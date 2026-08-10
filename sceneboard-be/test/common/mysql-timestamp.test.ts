import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatMysqlTimestampUtc,
  formatProtocolTimestampUtcForMysql,
  parseMysqlTimestampUtc,
} from '../../src/common/time/mysql-timestamp.js';

test('maps exact UTC millisecond timestamps without timezone ambiguity', () => {
  const date = new Date('2026-07-16T12:34:56.789Z');
  assert.equal(formatMysqlTimestampUtc(date), '2026-07-16 12:34:56.789');
  assert.equal(parseMysqlTimestampUtc('2026-07-16 12:34:56.789').toISOString(), date.toISOString());
  assert.equal(
    parseMysqlTimestampUtc('2026-07-16 12:34:56.789000').toISOString(),
    date.toISOString(),
  );
  assert.equal(
    parseMysqlTimestampUtc('2026-07-16 12:34:56').toISOString(),
    '2026-07-16T12:34:56.000Z',
  );
  assert.throws(() => parseMysqlTimestampUtc('2026-07-16 12:34:56.78'), /MySQL timestamp/);
  assert.throws(() => parseMysqlTimestampUtc('2026-07-16 12:34:56.789001'), /MySQL timestamp/);
  assert.throws(() => parseMysqlTimestampUtc('2026-07-16T12:34:56.789Z'), /MySQL timestamp/);
  assert.throws(() => formatMysqlTimestampUtc(new Date(Number.NaN)), /valid date/);
});

test('maps canonical protocol timestamps to MySQL without using the MySQL parser', () => {
  assert.equal(
    formatProtocolTimestampUtcForMysql('2026-07-16T12:34:56.789Z'),
    '2026-07-16 12:34:56.789',
  );
  assert.throws(
    () => formatProtocolTimestampUtcForMysql('2026-07-16 12:34:56.789'),
    /protocol timestamp/,
  );
  assert.throws(
    () => formatProtocolTimestampUtcForMysql('2026-07-16T12:34:56Z'),
    /protocol timestamp/,
  );
});
