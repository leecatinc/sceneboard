import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  MediaIdParserV1,
  MediaIngestResultParserV1,
  type MediaId,
  type MediaIngestResultV1,
  type MediaMimeV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { decodeMediaIdFromStorage, encodeMediaIdForStorage } from './media-reference.types.js';
import {
  invalidMediaUpload,
  mediaIdempotencyConflict,
  mediaIdempotencyExpired,
} from './media-errors.js';
import type {
  CanonicalMediaObjectV1,
  CanonicalMediaV1,
  LockedBoardMediaV1,
  MediaIngestFingerprintV1,
  MediaIngestRepositoryInputV1,
  MediaIngestRepositoryResultV1,
} from './media-repository.types.js';

interface QuotaRow extends RowDataPacket {
  usedBytes: string;
  version: string;
}

interface ObjectRow extends RowDataPacket {
  mediaPk: string;
  sha256: Buffer;
  bytes: Buffer;
  mime: MediaMimeV1;
  width: number;
  height: number;
  byteLength: number;
  state: 'active' | 'quarantined';
  version: string;
}

interface OwnershipRow extends RowDataPacket {
  boardMediaPk: string;
  boardPk: string;
  mediaPk: string;
  mediaId: Buffer;
  status: 'active' | 'quarantined' | 'released';
  leaseExpiresAt: string;
  version: string;
}

interface IdempotencyRow extends RowDataPacket {
  fingerprintSha256: Buffer;
  resultKind: 'active' | 'expired';
  resultJson: string | Record<string, unknown>;
  resultSha256: Buffer;
  boardMediaPk: string | null;
}

const parsePk = (value: string): bigint => {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new BoardPersistenceError('row_integrity');
  return BigInt(value);
};

const parseUnsigned = (value: string): bigint => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new BoardPersistenceError('row_integrity');
  return BigInt(value);
};

const fingerprintDigest = (value: MediaIngestFingerprintV1): Buffer =>
  createHash('sha256')
    .update(
      JSON.stringify({
        contentDigest: value.contentDigest,
        contentLength: value.contentLength,
        contentType: value.contentType,
      }),
      'utf8',
    )
    .digest();

const exactDigest = (left: Buffer, right: Buffer): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);

const parseResult = (row: IdempotencyRow): MediaIngestResultV1 => {
  const source =
    typeof row.resultJson === 'string' ? row.resultJson : JSON.stringify(row.resultJson);
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new BoardPersistenceError('row_integrity');
  }
  const parsed = MediaIngestResultParserV1.parse(decoded);
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  if (
    !exactDigest(createHash('sha256').update(parsed.data.canonicalBytes).digest(), row.resultSha256)
  )
    throw new BoardPersistenceError('row_integrity');
  return parsed.data.value;
};

const buildResult = (
  input: MediaIngestRepositoryInputV1,
  mediaId: MediaId,
  canonical: CanonicalMediaV1,
  status: 'created' | 'replayed',
): { value: MediaIngestResultV1; json: string; digest: Buffer } => {
  const parsed = MediaIngestResultParserV1.parse({
    protocolVersion: 1,
    type: 'media.ingest.result',
    requestId: input.requestId,
    status,
    media: {
      mediaId,
      sha256: canonical.sha256Hex,
      mime: canonical.mime,
      width: canonical.width,
      height: canonical.height,
      bytes: canonical.bytes.byteLength,
    },
  });
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  const json = Buffer.from(parsed.data.canonicalBytes).toString('utf8');
  return {
    value: parsed.data.value,
    json,
    digest: createHash('sha256').update(json, 'utf8').digest(),
  };
};

export class MediaRepository {
  constructor(
    private readonly createPublicId = (): string =>
      `media_${randomBytes(18).toString('base64url')}`,
  ) {}

  async hasIdempotency(
    connection: PoolConnection,
    accountPk: bigint,
    boardPk: bigint,
    idempotencyKey: string,
  ): Promise<boolean> {
    const row = await this.readIdempotency(connection, accountPk, boardPk, idempotencyKey, false);
    return row !== null;
  }

  async ingest(input: MediaIngestRepositoryInputV1): Promise<MediaIngestRepositoryResultV1> {
    const fingerprint = fingerprintDigest(input.fingerprint);
    await this.lockQuota(input.connection, input.boardPk);
    const replayLocator = await this.readIdempotency(
      input.connection,
      input.accountPk,
      input.boardPk,
      input.idempotencyKey,
      false,
    );
    if (replayLocator !== null) return this.replay(input, replayLocator, fingerprint);
    if (input.canonical === null) throw new BoardPersistenceError('row_integrity');
    const object = await this.lockOrCreateObject(input.connection, input.canonical);
    const ownership = await this.lockOrCreateOwnership(input.connection, input.boardPk, object);
    if (ownership.created)
      await this.chargeQuota(input.connection, input.boardPk, object.byteLength);
    const currentIdempotency = await this.readIdempotency(
      input.connection,
      input.accountPk,
      input.boardPk,
      input.idempotencyKey,
      true,
    );
    if (currentIdempotency !== null) return this.replay(input, currentIdempotency, fingerprint);
    const result = buildResult(input, ownership.value.mediaId, input.canonical, 'created');
    await input.connection.execute<ResultSetHeader>(
      `
      INSERT INTO media_ingest_idempotency (
        account_pk, board_pk, idempotency_key, fingerprint_sha256, result_kind,
        result_json, result_sha256, board_media_pk, recovery_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `,
      [
        input.accountPk.toString(),
        input.boardPk.toString(),
        Buffer.from(input.idempotencyKey, 'ascii'),
        fingerprint,
        result.json,
        result.digest,
        ownership.value.boardMediaPk.toString(),
      ],
    );
    return { result: result.value, replayed: false };
  }

  async getCanonicalObject(
    connection: PoolConnection,
    mediaPk: bigint,
  ): Promise<CanonicalMediaObjectV1 | null> {
    const [rows] = await connection.execute<ObjectRow[]>(
      `
      SELECT CAST(media_pk AS CHAR) AS mediaPk, sha256, bytes, mime, width, height,
             byte_length AS byteLength, state, CAST(version AS CHAR) AS version
      FROM media_objects WHERE media_pk = ? FOR UPDATE
    `,
      [mediaPk.toString()],
    );
    return rows[0] === undefined ? null : this.mapObject(rows[0]);
  }

  async lockBoardOwnership(
    connection: PoolConnection,
    boardPk: bigint,
    mediaId: MediaId,
  ): Promise<LockedBoardMediaV1 | null> {
    const [rows] = await connection.execute<OwnershipRow[]>(
      `
      SELECT CAST(board_media_pk AS CHAR) AS boardMediaPk, CAST(board_pk AS CHAR) AS boardPk,
             CAST(media_pk AS CHAR) AS mediaPk, media_id AS mediaId, status,
             DATE_FORMAT(lease_expires_at, '%Y-%m-%d %H:%i:%s.%f') AS leaseExpiresAt,
             CAST(version AS CHAR) AS version
      FROM board_media WHERE board_pk = ? AND media_id = ? FOR UPDATE
    `,
      [boardPk.toString(), encodeMediaIdForStorage(mediaId)],
    );
    return rows[0] === undefined ? null : this.mapOwnership(rows[0]);
  }

  async releaseExpiredOwnership(
    connection: PoolConnection,
    boardMediaPk: bigint,
    expectedVersion: bigint,
    dbNow: string,
  ): Promise<boolean> {
    const locator = await this.readOwnershipByPk(connection, boardMediaPk, false);
    if (locator === null) return false;
    await this.lockQuota(connection, locator.boardPk);
    const object = await this.getCanonicalObject(connection, locator.mediaPk);
    if (object === null) throw new BoardPersistenceError('row_integrity');
    const row = await this.readOwnershipByPk(connection, boardMediaPk, true);
    if (
      row === null ||
      row.boardPk !== locator.boardPk ||
      row.mediaPk !== locator.mediaPk ||
      row.status !== 'active' ||
      row.version !== expectedVersion ||
      row.leaseExpiresAt > dbNow
    )
      return false;
    await connection.execute(
      `
      UPDATE media_ingest_idempotency
      SET result_kind = 'expired', board_media_pk = NULL, updated_at = ?
      WHERE board_media_pk = ? AND result_kind = 'active'
    `,
      [dbNow, boardMediaPk.toString()],
    );
    const [released] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_media
      SET status = 'released', version = version + 1, updated_at = ?
      WHERE board_media_pk = ? AND version = ? AND status = 'active' AND lease_expires_at <= ?
    `,
      [dbNow, boardMediaPk.toString(), expectedVersion.toString(), dbNow],
    );
    if (released.affectedRows !== 1) return false;
    await this.decrementQuota(connection, row.boardPk, object.byteLength);
    return true;
  }

  async reconcileBoardQuota(connection: PoolConnection, boardPk: bigint): Promise<void> {
    const quota = await this.lockQuota(connection, boardPk);
    const [rows] = await connection.execute<Array<RowDataPacket & { actualBytes: string }>>(
      `
      SELECT CAST(COALESCE(SUM(o.byte_length), 0) AS CHAR) AS actualBytes
      FROM board_media bm JOIN media_objects o ON o.media_pk = bm.media_pk
      WHERE bm.board_pk = ? AND bm.status = 'active'
    `,
      [boardPk.toString()],
    );
    if (parseUnsigned(rows[0]?.actualBytes ?? '') !== quota.usedBytes)
      throw new BoardPersistenceError('row_integrity');
  }

  private async replay(
    input: MediaIngestRepositoryInputV1,
    locator: IdempotencyRow,
    fingerprint: Buffer,
  ): Promise<MediaIngestRepositoryResultV1> {
    if (!exactDigest(locator.fingerprintSha256, fingerprint))
      throw new BoardContractError(mediaIdempotencyConflict());
    if (locator.resultKind === 'expired' || locator.boardMediaPk === null)
      throw new BoardContractError(mediaIdempotencyExpired());
    const ownershipLocator = await this.readOwnershipByPk(
      input.connection,
      parsePk(locator.boardMediaPk),
      false,
    );
    if (ownershipLocator === null) throw new BoardContractError(mediaIdempotencyExpired());
    const object = await this.getCanonicalObject(input.connection, ownershipLocator.mediaPk);
    if (object === null || object.state !== 'active')
      throw new BoardPersistenceError('row_integrity');
    const ownership = await this.readOwnershipByPk(
      input.connection,
      ownershipLocator.boardMediaPk,
      true,
    );
    if (ownership === null || ownership.status !== 'active')
      throw new BoardContractError(mediaIdempotencyExpired());
    if (
      ownership.boardPk !== ownershipLocator.boardPk ||
      ownership.mediaPk !== ownershipLocator.mediaPk
    )
      throw new BoardPersistenceError('row_integrity');
    const locked = await this.readIdempotency(
      input.connection,
      input.accountPk,
      input.boardPk,
      input.idempotencyKey,
      true,
    );
    if (locked === null || locked.boardMediaPk !== locator.boardMediaPk)
      throw new BoardPersistenceError('row_integrity');
    await input.connection.execute(
      `
      UPDATE board_media
      SET lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR),
          version = version + 1, updated_at = UTC_TIMESTAMP(3)
      WHERE board_media_pk = ? AND status = 'active'
    `,
      [ownership.boardMediaPk.toString()],
    );
    const stored = parseResult(locked);
    if (
      stored.media.mediaId !== ownership.mediaId ||
      stored.media.sha256 !== object.sha256.toString('hex') ||
      stored.media.mime !== object.mime ||
      stored.media.width !== object.width ||
      stored.media.height !== object.height ||
      stored.media.bytes !== object.byteLength
    )
      throw new BoardPersistenceError('row_integrity');
    const replayed = buildResult(
      input,
      ownership.mediaId,
      {
        bytes: object.bytes,
        sha256: object.sha256,
        sha256Hex: object.sha256.toString('hex'),
        mime: object.mime,
        width: object.width,
        height: object.height,
      },
      'replayed',
    );
    return {
      result: replayed.value,
      replayed: true,
    };
  }

  private async lockQuota(
    connection: PoolConnection,
    boardPk: bigint,
  ): Promise<{ usedBytes: bigint; version: bigint }> {
    await connection.execute(
      `
      INSERT INTO board_media_quota (board_pk, used_bytes, version, updated_at)
      VALUES (?, 0, 1, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE board_pk = VALUES(board_pk)
    `,
      [boardPk.toString()],
    );
    const [rows] = await connection.execute<QuotaRow[]>(
      `
      SELECT CAST(used_bytes AS CHAR) AS usedBytes, CAST(version AS CHAR) AS version
      FROM board_media_quota WHERE board_pk = ? FOR UPDATE
    `,
      [boardPk.toString()],
    );
    const row = rows[0];
    if (row === undefined) throw new BoardPersistenceError('row_integrity');
    return { usedBytes: parseUnsigned(row.usedBytes), version: parsePk(row.version) };
  }

  private async chargeQuota(
    connection: PoolConnection,
    boardPk: bigint,
    byteLength: number,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_media_quota
      SET used_bytes = used_bytes + ?, version = version + 1, updated_at = UTC_TIMESTAMP(3)
      WHERE board_pk = ? AND used_bytes + ? <= 536870912
    `,
      [byteLength, boardPk.toString(), byteLength],
    );
    if (result.affectedRows !== 1) throw new BoardContractError(invalidMediaUpload('quota'));
  }

  private async decrementQuota(
    connection: PoolConnection,
    boardPk: bigint,
    byteLength: number,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_media_quota
      SET used_bytes = used_bytes - ?, version = version + 1, updated_at = UTC_TIMESTAMP(3)
      WHERE board_pk = ? AND used_bytes >= ?
    `,
      [byteLength, boardPk.toString(), byteLength],
    );
    if (result.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
  }

  private async lockOrCreateObject(
    connection: PoolConnection,
    canonical: CanonicalMediaV1,
  ): Promise<CanonicalMediaObjectV1> {
    await connection.execute(
      `
      INSERT INTO media_objects (
        sha256, bytes, mime, width, height, byte_length, state, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE media_pk = LAST_INSERT_ID(media_pk)
    `,
      [
        canonical.sha256,
        canonical.bytes,
        canonical.mime,
        canonical.width,
        canonical.height,
        canonical.bytes.byteLength,
      ],
    );
    const [rows] = await connection.execute<ObjectRow[]>(
      `
      SELECT CAST(media_pk AS CHAR) AS mediaPk, sha256, bytes, mime, width, height,
             byte_length AS byteLength, state, CAST(version AS CHAR) AS version
      FROM media_objects WHERE sha256 = ? FOR UPDATE
    `,
      [canonical.sha256],
    );
    const object = rows[0] === undefined ? null : this.mapObject(rows[0]);
    if (
      object === null ||
      object.state !== 'active' ||
      object.byteLength !== canonical.bytes.byteLength ||
      !exactDigest(object.sha256, canonical.sha256) ||
      !exactDigest(object.bytes, canonical.bytes)
    )
      throw new BoardPersistenceError('row_integrity');
    return object;
  }

  private async lockOrCreateOwnership(
    connection: PoolConnection,
    boardPk: bigint,
    object: CanonicalMediaObjectV1,
  ): Promise<{ value: LockedBoardMediaV1; created: boolean }> {
    const existing = await this.lockOwnershipByObject(connection, boardPk, object.mediaPk);
    if (existing !== null) {
      if (existing.status !== 'active') throw new BoardPersistenceError('row_integrity');
      return { value: existing, created: false };
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parsed = MediaIdParserV1.parse(this.createPublicId());
      if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
      const [insert] = await connection.execute<ResultSetHeader>(
        `
        INSERT IGNORE INTO board_media (
          board_pk, media_pk, media_id, status, lease_expires_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR), 1,
                  UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
      `,
        [boardPk.toString(), object.mediaPk.toString(), encodeMediaIdForStorage(parsed.data.value)],
      );
      const locked = await this.lockOwnershipByObject(connection, boardPk, object.mediaPk);
      if (locked !== null) return { value: locked, created: insert.affectedRows === 1 };
    }
    throw new BoardPersistenceError('row_integrity');
  }

  private async lockOwnershipByObject(
    connection: PoolConnection,
    boardPk: bigint,
    mediaPk: bigint,
  ): Promise<LockedBoardMediaV1 | null> {
    const [rows] = await connection.execute<OwnershipRow[]>(
      `
      SELECT CAST(board_media_pk AS CHAR) AS boardMediaPk, CAST(board_pk AS CHAR) AS boardPk,
             CAST(media_pk AS CHAR) AS mediaPk, media_id AS mediaId, status,
             DATE_FORMAT(lease_expires_at, '%Y-%m-%d %H:%i:%s.%f') AS leaseExpiresAt,
             CAST(version AS CHAR) AS version
      FROM board_media WHERE board_pk = ? AND media_pk = ? FOR UPDATE
    `,
      [boardPk.toString(), mediaPk.toString()],
    );
    return rows[0] === undefined ? null : this.mapOwnership(rows[0]);
  }

  private async readOwnershipByPk(
    connection: PoolConnection,
    boardMediaPk: bigint,
    lock: boolean,
  ): Promise<LockedBoardMediaV1 | null> {
    const [rows] = await connection.execute<OwnershipRow[]>(
      `
      SELECT CAST(board_media_pk AS CHAR) AS boardMediaPk, CAST(board_pk AS CHAR) AS boardPk,
             CAST(media_pk AS CHAR) AS mediaPk, media_id AS mediaId, status,
             DATE_FORMAT(lease_expires_at, '%Y-%m-%d %H:%i:%s.%f') AS leaseExpiresAt,
             CAST(version AS CHAR) AS version
      FROM board_media WHERE board_media_pk = ? ${lock ? 'FOR UPDATE' : ''}
    `,
      [boardMediaPk.toString()],
    );
    return rows[0] === undefined ? null : this.mapOwnership(rows[0]);
  }

  private async readIdempotency(
    connection: PoolConnection,
    accountPk: bigint,
    boardPk: bigint,
    idempotencyKey: string,
    lock: boolean,
  ): Promise<IdempotencyRow | null> {
    const [rows] = await connection.execute<IdempotencyRow[]>(
      `
      SELECT fingerprint_sha256 AS fingerprintSha256, result_kind AS resultKind,
             result_json AS resultJson, result_sha256 AS resultSha256,
             CAST(board_media_pk AS CHAR) AS boardMediaPk
      FROM media_ingest_idempotency
      WHERE account_pk = ? AND board_pk = ? AND idempotency_key = ?
      ${lock ? 'FOR UPDATE' : ''}
    `,
      [accountPk.toString(), boardPk.toString(), Buffer.from(idempotencyKey, 'ascii')],
    );
    return rows[0] ?? null;
  }

  private mapObject(row: ObjectRow): CanonicalMediaObjectV1 {
    if (
      !Buffer.isBuffer(row.sha256) ||
      row.sha256.byteLength !== 32 ||
      !Buffer.isBuffer(row.bytes) ||
      row.bytes.byteLength !== row.byteLength ||
      !Number.isInteger(row.width) ||
      !Number.isInteger(row.height)
    )
      throw new BoardPersistenceError('row_integrity');
    return {
      mediaPk: parsePk(row.mediaPk),
      sha256: row.sha256,
      bytes: row.bytes,
      mime: row.mime,
      width: row.width,
      height: row.height,
      byteLength: row.byteLength,
      state: row.state,
      version: parsePk(row.version),
    };
  }

  private mapOwnership(row: OwnershipRow): LockedBoardMediaV1 {
    return {
      boardMediaPk: parsePk(row.boardMediaPk),
      boardPk: parsePk(row.boardPk),
      mediaPk: parsePk(row.mediaPk),
      mediaId: decodeMediaIdFromStorage(row.mediaId),
      status: row.status,
      leaseExpiresAt: row.leaseExpiresAt,
      version: parsePk(row.version),
    };
  }
}
