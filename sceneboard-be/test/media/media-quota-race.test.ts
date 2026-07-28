import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import type { CanonicalMediaV1 } from '../../src/media/media-repository.types.js';
import { MediaRepository } from '../../src/media/media.repository.js';

const normalized = (sql: string): string => sql.replace(/\s+/gu, ' ').trim();

class MediaConnection {
  readonly calls: string[] = [];
  readonly quota = new Map<string, number>();
  readonly objects = new Map<string, Record<string, unknown>>();
  readonly ownerships = new Map<string, Record<string, unknown>>();
  readonly idempotency = new Map<string, Record<string, unknown>>();
  private nextObject = 1;
  private nextOwnership = 1;

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<unknown> {
    const statement = normalized(sql);
    this.calls.push(statement);
    if (statement.startsWith('INSERT INTO board_media_quota')) {
      const board = String(parameters[0]);
      if (!this.quota.has(board)) this.quota.set(board, 0);
      return [{ affectedRows: 1 }, []];
    }
    if (statement.startsWith('SELECT CAST(used_bytes AS CHAR)')) {
      const used = this.quota.get(String(parameters[0])) ?? 0;
      return [[{ usedBytes: String(used), version: '1' }], []];
    }
    if (statement.startsWith('SELECT fingerprint_sha256')) {
      const key = `${parameters[0]}:${parameters[1]}:${Buffer.from(parameters[2] as Buffer).toString('ascii')}`;
      const value = this.idempotency.get(key);
      return [value === undefined ? [] : [value], []];
    }
    if (statement.startsWith('INSERT INTO media_objects')) {
      const hash = Buffer.from(parameters[0] as Buffer).toString('hex');
      if (!this.objects.has(hash)) {
        this.objects.set(hash, {
          mediaPk: String(this.nextObject++),
          sha256: parameters[0],
          bytes: parameters[1],
          mime: parameters[2],
          width: parameters[3],
          height: parameters[4],
          byteLength: parameters[5],
          state: 'active',
          version: '1',
        });
      }
      return [{ affectedRows: 1 }, []];
    }
    if (statement.includes('FROM media_objects WHERE sha256 = ?')) {
      const value = this.objects.get(Buffer.from(parameters[0] as Buffer).toString('hex'));
      return [value === undefined ? [] : [value], []];
    }
    if (statement.includes('FROM board_media WHERE board_pk = ? AND media_pk = ?')) {
      const value = this.ownerships.get(`${parameters[0]}:${parameters[1]}`);
      return [value === undefined ? [] : [value], []];
    }
    if (statement.startsWith('INSERT IGNORE INTO board_media')) {
      const key = `${parameters[0]}:${parameters[1]}`;
      if (this.ownerships.has(key)) return [{ affectedRows: 0 }, []];
      this.ownerships.set(key, {
        boardMediaPk: String(this.nextOwnership++),
        boardPk: String(parameters[0]),
        mediaPk: String(parameters[1]),
        mediaId: parameters[2],
        status: 'active',
        leaseExpiresAt: '2026-07-29 00:00:00.000000',
        version: '1',
      });
      return [{ affectedRows: 1 }, []];
    }
    if (statement.startsWith('UPDATE board_media_quota SET used_bytes = used_bytes +')) {
      const board = String(parameters[1]);
      this.quota.set(board, (this.quota.get(board) ?? 0) + Number(parameters[0]));
      return [{ affectedRows: 1 }, []];
    }
    if (statement.startsWith('INSERT INTO media_ingest_idempotency')) {
      const key = `${parameters[0]}:${parameters[1]}:${Buffer.from(parameters[2] as Buffer).toString('ascii')}`;
      this.idempotency.set(key, {
        fingerprintSha256: parameters[3],
        resultKind: 'active',
        resultJson: parameters[4],
        resultSha256: parameters[5],
        boardMediaPk: String(parameters[6]),
      });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected SQL: ${statement}`);
  }
}

const canonical = (): CanonicalMediaV1 => {
  const bytes = Buffer.from('canonical-image');
  const sha256 = createHash('sha256').update(bytes).digest();
  return {
    bytes,
    sha256,
    sha256Hex: sha256.toString('hex'),
    mime: 'image/png',
    width: 2,
    height: 2,
  };
};

test('dedupes one global object while charging each board ownership exactly once', async () => {
  let id = 0;
  const repository = new MediaRepository(() => `media_${++id}`);
  const connection = new MediaConnection();
  const ingest = (boardPk: bigint, key: string) =>
    repository.ingest({
      connection: connection as unknown as PoolConnection,
      accountPk: 1n,
      boardPk,
      requestId: `request_${key}` as never,
      idempotencyKey: key,
      fingerprint: {
        contentType: 'image/png',
        contentLength: 15,
        contentDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
      },
      canonical: canonical(),
    });
  const first = await ingest(10n, 'media-key-000001');
  const sameBoard = await ingest(10n, 'media-key-000002');
  const otherBoard = await ingest(11n, 'media-key-000003');
  assert.equal(connection.objects.size, 1);
  assert.equal(connection.ownerships.size, 2);
  assert.equal(connection.quota.get('10'), 15);
  assert.equal(connection.quota.get('11'), 15);
  assert.equal(first.result.media.mediaId, sameBoard.result.media.mediaId);
  assert.notEqual(first.result.media.mediaId, otherBoard.result.media.mediaId);
  assert.equal(
    connection.calls.filter((call) =>
      call.startsWith('UPDATE board_media_quota SET used_bytes = used_bytes +'),
    ).length,
    2,
  );
});
