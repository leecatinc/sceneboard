import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardEventEnvelopeParserV1,
  ShareManagementViewParserV1,
  SharePasswordReplayResultParserV1,
  ShareSecretReplayResultParserV1,
  ShareUpdateSuccessParserV1,
  canonicalizeJsonV1,
  type BoardId,
  type BoardEventEnvelopeV1,
  type RevisionId,
  type ShareManagementViewV1,
  type SharePasswordReplayResultV1,
  type ShareSecretReplayResultV1,
  type ShareStatusV1,
  type ShareUpdateSuccessV1,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import type { AuditEventName } from '../audit/audit-events.js';
import { ShareContractError } from '../common/errors/app-error.js';
import {
  formatPublicUuidV4,
  generatePublicUuidV4,
  parsePublicUuidV4,
} from '../common/ids/public-uuid.storage.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';

const MAX_GENERATION = 9_007_199_254_740_991;

export type LockedShare = {
  sharePk: bigint;
  shareId: string;
  boardPk: bigint;
  status: ShareStatusV1;
  accessPolicy: 'L' | 'P';
  pinnedRevisionPk: bigint;
  pinnedRevisionId: RevisionId;
  publicationGeneration: number;
  accessGeneration: number;
  tokenDigest: Buffer;
  version: number;
  createdAtSql: string;
  updatedAtSql: string;
  credential: LockedShareCredential | null;
};

export type LockedShareCredential = {
  credentialVersion: number;
  passwordHash: Buffer;
  passwordHashSha256: Buffer;
  salt: Buffer;
  hashVersion: 'S1';
  pepperVersion: number;
};

export type LockedShareRevision = {
  revisionPk: bigint;
  revisionId: RevisionId;
};

export type ShareOperation =
  | 'create'
  | 'republish'
  | 'update'
  | 'rotate'
  | 'revoke'
  | 'password.enable'
  | 'password.regenerate'
  | 'password.disable';

export type StoredShareReplay =
  | { operation: 'create' | 'republish' | 'rotate'; value: ShareSecretReplayResultV1 }
  | { operation: 'update'; value: ShareUpdateSuccessV1 }
  | { operation: 'revoke' | 'password.disable'; value: null }
  | {
      operation: 'password.enable' | 'password.regenerate';
      value: SharePasswordReplayResultV1;
    };

interface ShareRow extends RowDataPacket {
  sharePk: string;
  shareId: string;
  boardPk: string;
  status: string;
  accessPolicy: string;
  pinnedRevisionPk: string;
  pinnedRevisionId: Buffer;
  publicationGeneration: string;
  accessGeneration: string;
  tokenDigest: Buffer;
  version: string;
  createdAt: string;
  updatedAt: string;
  credentialVersion: string | null;
  passwordHash: Buffer | null;
  salt: Buffer | null;
  hashVersion: string | null;
  pepperVersion: number | string | null;
}

interface RevisionRow extends RowDataPacket {
  revisionPk: string;
  revisionId: Buffer;
}

interface IdempotencyRow extends RowDataPacket {
  operation: ShareOperation;
  fingerprintSha256: Buffer;
  resultJson: string;
  resultJsonSha256: Buffer;
  sharePk: string;
  recoveryId: string | null;
}

interface ShareEventHeadRow extends RowDataPacket {
  revisionId: Buffer;
  lastEventSequence: string;
}

const databasePk = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new ShareContractError('BOARD_NOT_FOUND');
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new ShareContractError('BOARD_NOT_FOUND');
  return parsed;
};

const safePositive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) throw new ShareContractError('BOARD_NOT_FOUND');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ShareContractError('BOARD_NOT_FOUND');
  return parsed;
};

const status = (value: string): ShareStatusV1 => {
  if (value !== 'active' && value !== 'revoked' && value !== 'archived') {
    throw new ShareContractError('BOARD_NOT_FOUND');
  }
  return value;
};

const accessPolicy = (value: string): 'L' | 'P' => {
  if (value !== 'L' && value !== 'P') throw new ShareContractError('BOARD_NOT_FOUND');
  return value;
};

const mapCredential = (row: ShareRow): LockedShareCredential | null => {
  if (
    row.credentialVersion === null &&
    row.passwordHash === null &&
    row.salt === null &&
    row.hashVersion === null &&
    row.pepperVersion === null
  ) {
    return null;
  }
  if (
    row.credentialVersion === null ||
    row.passwordHash?.byteLength !== 32 ||
    row.salt?.byteLength !== 16 ||
    row.hashVersion !== 'S1'
  ) {
    throw new ShareContractError('BOARD_NOT_FOUND');
  }
  const pepperVersion = Number(row.pepperVersion);
  if (!Number.isSafeInteger(pepperVersion) || pepperVersion < 1 || pepperVersion > 65_535) {
    throw new ShareContractError('BOARD_NOT_FOUND');
  }
  return {
    credentialVersion: safePositive(row.credentialVersion),
    passwordHash: Buffer.from(row.passwordHash),
    passwordHashSha256: createHash('sha256').update(row.passwordHash).digest(),
    salt: Buffer.from(row.salt),
    hashVersion: 'S1',
    pepperVersion,
  };
};

const insertedPk = (result: ResultSetHeader): bigint => {
  if (result.affectedRows !== 1 || result.insertId < 1) {
    throw new ShareContractError('SHARE_STATE_CONFLICT');
  }
  return BigInt(result.insertId);
};

const timestamp = (value: string): TimestampV1 =>
  parseMysqlTimestampUtc(value).toISOString() as TimestampV1;

const mapShare = (row: ShareRow): LockedShare => ({
  sharePk: databasePk(row.sharePk),
  shareId: row.shareId,
  boardPk: databasePk(row.boardPk),
  status: status(row.status),
  accessPolicy: accessPolicy(row.accessPolicy),
  pinnedRevisionPk: databasePk(row.pinnedRevisionPk),
  pinnedRevisionId: formatPublicUuidV4(row.pinnedRevisionId) as RevisionId,
  publicationGeneration: safePositive(row.publicationGeneration),
  accessGeneration: safePositive(row.accessGeneration),
  tokenDigest: Buffer.from(row.tokenDigest),
  version: safePositive(row.version),
  createdAtSql: row.createdAt,
  updatedAtSql: row.updatedAt,
  credential: mapCredential(row),
});

const shareSelect = `
  SELECT CAST(s.share_pk AS CHAR) AS sharePk, s.share_id AS shareId,
         CAST(s.board_pk AS CHAR) AS boardPk, s.status, s.access_policy AS accessPolicy,
         CAST(s.pinned_revision_pk AS CHAR) AS pinnedRevisionPk,
         r.revision_id AS pinnedRevisionId,
         CAST(s.publication_generation AS CHAR) AS publicationGeneration,
         CAST(s.access_generation AS CHAR) AS accessGeneration,
         s.token_digest AS tokenDigest, CAST(s.version AS CHAR) AS version,
         s.created_at AS createdAt, s.updated_at AS updatedAt,
         CAST(c.credential_version AS CHAR) AS credentialVersion,
         c.password_hash AS passwordHash, c.salt,
         c.hash_version AS hashVersion, c.pepper_version AS pepperVersion
  FROM board_shares s
  JOIN board_revisions r
    ON r.board_pk = s.board_pk AND r.revision_pk = s.pinned_revision_pk
  LEFT JOIN share_password_credentials c ON c.share_pk = s.share_pk
`;

const canonicalBytes = (value: unknown): Buffer => {
  const parsed = canonicalizeJsonV1(value);
  if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
  return Buffer.from(parsed.data.canonicalBytes);
};

export const shareStateDigest = (
  value: null | {
    shareId: string;
    boardPk: bigint;
    status: ShareStatusV1;
    accessPolicy: 'L' | 'P';
    pinnedRevisionPk: bigint;
    publicationGeneration: number;
    accessGeneration: number;
    tokenDigest: Uint8Array;
    version: number;
    credential?: LockedShareCredential | null;
  },
): Buffer => {
  if (value === null) return createHash('sha256').update('absent', 'ascii').digest();
  return createHash('sha256')
    .update(
      canonicalBytes({
        shareId: value.shareId,
        boardPk: value.boardPk.toString(),
        status: value.status,
        accessPolicy: value.accessPolicy,
        pinnedRevisionPk: value.pinnedRevisionPk.toString(),
        publicationGeneration: value.publicationGeneration,
        accessGeneration: value.accessGeneration,
        tokenDigestSha256: Buffer.from(value.tokenDigest).toString('hex'),
        version: value.version,
        credential:
          value.credential == null
            ? {
                credentialPresent: false,
                credentialVersion: null,
                passwordHashSha256: null,
                pepperVersion: null,
              }
            : {
                credentialPresent: true,
                credentialVersion: value.credential.credentialVersion,
                passwordHashSha256: value.credential.passwordHashSha256.toString('hex'),
                pepperVersion: value.credential.pepperVersion,
              },
      }),
    )
    .digest();
};

export const shareView = (share: LockedShare): ShareManagementViewV1 => {
  const parsed = ShareManagementViewParserV1.parse({
    shareId: share.shareId,
    status: share.status,
    accessPolicy: share.accessPolicy,
    pinnedRevisionId: share.pinnedRevisionId,
    publicationGeneration: share.publicationGeneration,
    accessGeneration: share.accessGeneration,
    version: share.version,
    createdAt: timestamp(share.createdAtSql),
    updatedAt: timestamp(share.updatedAtSql),
  });
  if (!parsed.ok) throw new ShareContractError('BOARD_NOT_FOUND');
  return parsed.data.value;
};

export class ShareRepository {
  constructor(
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
    private readonly generateUuid: () => string = generatePublicUuidV4,
  ) {}

  nextGeneration(value: number): number {
    if (value >= MAX_GENERATION) throw new ShareContractError('SHARE_GENERATION_EXHAUSTED');
    return value + 1;
  }

  newShareId(): string {
    return `share_${this.crypto.generatePublicIdV1()}`;
  }

  newRecoveryId(): string {
    return `share_recovery_${this.generateUuid()}`;
  }

  async assertBoardActive(connection: PoolConnection, boardPk: bigint): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT board_pk
       FROM boards
       WHERE board_pk = ? AND archived_at IS NULL
       LIMIT 1`,
      [boardPk.toString()],
    );
    if (rows.length !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  async lockShare(connection: PoolConnection, boardPk: bigint): Promise<LockedShare | null> {
    const [rows] = await connection.execute<ShareRow[]>(
      `${shareSelect} WHERE s.board_pk = ? LIMIT 1 FOR UPDATE`,
      [boardPk.toString()],
    );
    return rows.length === 1 ? mapShare(rows[0]!) : null;
  }

  async readShare(connection: PoolConnection, boardPk: bigint): Promise<LockedShare | null> {
    const [rows] = await connection.execute<ShareRow[]>(
      `${shareSelect} WHERE s.board_pk = ? LIMIT 1`,
      [boardPk.toString()],
    );
    return rows.length === 1 ? mapShare(rows[0]!) : null;
  }

  async readShareByTokenDigest(
    connection: PoolConnection,
    tokenDigest: Buffer,
  ): Promise<LockedShare | null> {
    const [rows] = await connection.execute<ShareRow[]>(
      `${shareSelect} WHERE s.token_digest = ? LIMIT 1`,
      [tokenDigest],
    );
    return rows.length === 1 ? mapShare(rows[0]!) : null;
  }

  async lockShareByTokenDigest(
    connection: PoolConnection,
    tokenDigest: Buffer,
  ): Promise<LockedShare | null> {
    const [rows] = await connection.execute<ShareRow[]>(
      `${shareSelect} WHERE s.token_digest = ? LIMIT 1 FOR UPDATE`,
      [tokenDigest],
    );
    return rows.length === 1 ? mapShare(rows[0]!) : null;
  }

  async lockShareByPk(connection: PoolConnection, sharePk: bigint): Promise<LockedShare | null> {
    const [rows] = await connection.execute<ShareRow[]>(
      `${shareSelect} WHERE s.share_pk = ? LIMIT 1 FOR UPDATE`,
      [sharePk.toString()],
    );
    return rows.length === 1 ? mapShare(rows[0]!) : null;
  }

  async lockRevision(
    connection: PoolConnection,
    boardPk: bigint,
    revisionId: RevisionId,
  ): Promise<LockedShareRevision> {
    let storedRevisionId: Uint8Array;
    try {
      storedRevisionId = parsePublicUuidV4(revisionId);
    } catch {
      throw new ShareContractError('BOARD_NOT_FOUND');
    }
    const [rows] = await connection.execute<RevisionRow[]>(
      `SELECT CAST(r.revision_pk AS CHAR) AS revisionPk, r.revision_id AS revisionId
       FROM board_revision_catalog c
       JOIN board_revisions r
         ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
       JOIN board_revision_payloads p
         ON p.revision_pk = r.revision_pk AND p.state = 'available'
       WHERE c.board_pk = ? AND r.revision_id = ?
       LIMIT 1 FOR UPDATE`,
      [boardPk.toString(), Buffer.from(storedRevisionId)],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new ShareContractError('BOARD_NOT_FOUND');
    return {
      revisionPk: databasePk(row.revisionPk),
      revisionId: formatPublicUuidV4(row.revisionId) as RevisionId,
    };
  }

  async createShare(
    connection: PoolConnection,
    input: {
      shareId: string;
      boardPk: bigint;
      revisionPk: bigint;
      tokenDigest: Buffer;
      nowSql: string;
    },
  ): Promise<LockedShare> {
    const [created] = await connection.execute<ResultSetHeader>(
      `INSERT INTO board_shares (
         share_id, board_pk, status, access_policy, pinned_revision_pk,
         publication_generation, access_generation, token_digest, version,
         created_at, updated_at
       ) VALUES (?, ?, 'active', 'L', ?, 1, 1, ?, 1, ?, ?)`,
      [
        input.shareId,
        input.boardPk.toString(),
        input.revisionPk.toString(),
        input.tokenDigest,
        input.nowSql,
        input.nowSql,
      ],
    );
    insertedPk(created);
    const share = await this.lockShare(connection, input.boardPk);
    if (share === null) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return share;
  }

  async republish(
    connection: PoolConnection,
    share: LockedShare,
    revisionPk: bigint,
    tokenDigest: Buffer,
    nowSql: string,
  ): Promise<LockedShare> {
    const publicationGeneration = this.nextGeneration(share.publicationGeneration);
    const accessGeneration = this.nextGeneration(share.accessGeneration);
    const version = this.nextGeneration(share.version);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET status = 'active', access_policy = 'L', pinned_revision_pk = ?,
           publication_generation = ?, access_generation = ?, token_digest = ?,
           version = ?, updated_at = ?
       WHERE share_pk = ? AND status = 'revoked' AND version = ?`,
      [
        revisionPk.toString(),
        publicationGeneration,
        accessGeneration,
        tokenDigest,
        version,
        nowSql,
        share.sharePk.toString(),
        share.version,
      ],
    );
    if (updated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return (await this.lockShare(connection, share.boardPk))!;
  }

  async updatePin(
    connection: PoolConnection,
    share: LockedShare,
    revisionPk: bigint,
    nowSql: string,
  ): Promise<LockedShare> {
    const publicationGeneration = this.nextGeneration(share.publicationGeneration);
    const version = this.nextGeneration(share.version);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET pinned_revision_pk = ?, publication_generation = ?,
           version = ?, updated_at = ?
       WHERE share_pk = ? AND status = 'active' AND version = ?`,
      [
        revisionPk.toString(),
        publicationGeneration,
        version,
        nowSql,
        share.sharePk.toString(),
        share.version,
      ],
    );
    if (updated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return (await this.lockShare(connection, share.boardPk))!;
  }

  async rotate(
    connection: PoolConnection,
    share: LockedShare,
    tokenDigest: Buffer,
    nowSql: string,
  ): Promise<LockedShare> {
    const accessGeneration = this.nextGeneration(share.accessGeneration);
    const version = this.nextGeneration(share.version);
    await this.invalidatePasswordAccess(connection, share.sharePk, false);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET token_digest = ?, access_generation = ?, version = ?, updated_at = ?
       WHERE share_pk = ? AND status = 'active' AND version = ?`,
      [tokenDigest, accessGeneration, version, nowSql, share.sharePk.toString(), share.version],
    );
    if (updated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return (await this.lockShare(connection, share.boardPk))!;
  }

  async revoke(
    connection: PoolConnection,
    share: LockedShare,
    nowSql: string,
  ): Promise<LockedShare> {
    const accessGeneration = this.nextGeneration(share.accessGeneration);
    const version = this.nextGeneration(share.version);
    await this.invalidatePasswordAccess(connection, share.sharePk, true);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET status = 'revoked', access_policy = 'L', access_generation = ?,
           version = ?, updated_at = ?
       WHERE share_pk = ? AND status = 'active' AND version = ?`,
      [accessGeneration, version, nowSql, share.sharePk.toString(), share.version],
    );
    if (updated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return (await this.lockShare(connection, share.boardPk))!;
  }

  async archive(
    connection: PoolConnection,
    share: LockedShare,
    nowSql: string,
  ): Promise<LockedShare> {
    const accessGeneration =
      share.status === 'active'
        ? this.nextGeneration(share.accessGeneration)
        : share.accessGeneration;
    const version = this.nextGeneration(share.version);
    await this.invalidatePasswordAccess(connection, share.sharePk, true);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET status = 'archived', access_policy = 'L', access_generation = ?,
           version = ?, updated_at = ?
       WHERE share_pk = ? AND status IN ('active','revoked') AND version = ?`,
      [accessGeneration, version, nowSql, share.sharePk.toString(), share.version],
    );
    if (updated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return (await this.lockShare(connection, share.boardPk))!;
  }

  async invalidatePasswordAccess(
    connection: PoolConnection,
    sharePk: bigint,
    deleteCredential: boolean,
  ): Promise<void> {
    await connection.execute<ResultSetHeader>(
      'DELETE FROM share_password_session_grants WHERE share_pk = ?',
      [sharePk.toString()],
    );
    if (deleteCredential) {
      await connection.execute<ResultSetHeader>(
        'DELETE FROM share_password_credentials WHERE share_pk = ?',
        [sharePk.toString()],
      );
    }
  }

  async acquireHold(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      revisionPk: bigint;
      kind: 'published' | 'recovery';
      holderId: string;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO board_revision_holds (
         board_pk, revision_pk, kind, holder_id, expires_at, released_at
       ) VALUES (?, ?, ?, ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE
         released_at = IF(released_at IS NULL, NULL, released_at)`,
      [input.boardPk.toString(), input.revisionPk.toString(), input.kind, input.holderId],
    );
    if (result.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  async releaseHold(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      revisionPk: bigint;
      kind: 'published' | 'recovery';
      holderId: string;
      nowSql: string;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_holds
       SET released_at = COALESCE(released_at, ?)
       WHERE board_pk = ? AND revision_pk = ? AND kind = ? AND holder_id = ?`,
      [
        input.nowSql,
        input.boardPk.toString(),
        input.revisionPk.toString(),
        input.kind,
        input.holderId,
      ],
    );
    if (result.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  publicationHolder(shareId: string, generation: number): string {
    return `share:${shareId}:${generation}`;
  }

  recoveryHolder(recoveryId: string): string {
    return `share-transition:${recoveryId}`;
  }

  async findReplay(
    connection: PoolConnection,
    input: {
      accountPk: bigint;
      boardPk: bigint;
      idempotencyKey: string;
      operations: readonly ShareOperation[];
      fingerprintSha256: Buffer;
    },
  ): Promise<StoredShareReplay | null> {
    const [rows] = await connection.execute<IdempotencyRow[]>(
      `SELECT operation, fingerprint_sha256 AS fingerprintSha256,
              CAST(result_json AS CHAR) AS resultJson,
              result_json_sha256 AS resultJsonSha256,
              CAST(share_pk AS CHAR) AS sharePk, recovery_id AS recoveryId
       FROM share_request_idempotency
       WHERE account_pk = ? AND board_pk = ? AND idempotency_key = ?
         AND operation IN (${input.operations.map(() => '?').join(', ')})
       LIMIT 2 FOR UPDATE`,
      [
        input.accountPk.toString(),
        input.boardPk.toString(),
        input.idempotencyKey,
        ...input.operations,
      ],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ShareContractError('IDEMPOTENCY_KEY_REUSED');
    const row = rows[0]!;
    if (
      row.fingerprintSha256.byteLength !== input.fingerprintSha256.byteLength ||
      !timingSafeEqual(row.fingerprintSha256, input.fingerprintSha256)
    ) {
      throw new ShareContractError('IDEMPOTENCY_KEY_REUSED');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.resultJson);
    } catch {
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    }
    const digest = createHash('sha256').update(canonicalBytes(decoded)).digest();
    if (
      row.resultJsonSha256.byteLength !== digest.byteLength ||
      !timingSafeEqual(row.resultJsonSha256, digest)
    ) {
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    }
    if (row.operation === 'update') {
      const parsed = ShareUpdateSuccessParserV1.parse(decoded);
      if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
      return { operation: row.operation, value: parsed.data.value };
    }
    if (row.operation === 'revoke' || row.operation === 'password.disable') {
      return { operation: row.operation, value: null };
    }
    if (row.operation === 'password.enable' || row.operation === 'password.regenerate') {
      const parsed = SharePasswordReplayResultParserV1.parse(decoded);
      if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
      return { operation: row.operation, value: parsed.data.value };
    }
    const parsed = ShareSecretReplayResultParserV1.parse(decoded);
    if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return { operation: row.operation, value: parsed.data.value };
  }

  async persistIdempotency(
    connection: PoolConnection,
    input: {
      accountPk: bigint;
      boardPk: bigint;
      operation: ShareOperation;
      idempotencyKey: string;
      fingerprintSha256: Buffer;
      resultKind:
        | 'created'
        | 'republished'
        | 'updated'
        | 'unchanged'
        | 'rotated'
        | 'revoked'
        | 'password-enabled'
        | 'password-regenerated'
        | 'password-disabled';
      result: unknown;
      sharePk: bigint;
      recoveryId: string | null;
      nowSql: string;
    },
  ): Promise<void> {
    const payload = canonicalBytes(input.result);
    const [created] = await connection.execute<ResultSetHeader>(
      `INSERT INTO share_request_idempotency (
         account_pk, board_pk, operation, idempotency_key, fingerprint_sha256,
         result_kind, result_json_sha256, result_json, share_pk, recovery_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)`,
      [
        input.accountPk.toString(),
        input.boardPk.toString(),
        input.operation,
        input.idempotencyKey,
        input.fingerprintSha256,
        input.resultKind,
        createHash('sha256').update(payload).digest(),
        payload.toString('utf8'),
        input.sharePk.toString(),
        input.recoveryId,
        input.nowSql,
      ],
    );
    if (created.affectedRows !== 1) throw new ShareContractError('IDEMPOTENCY_KEY_REUSED');
  }

  async writeAudit(
    connection: PoolConnection,
    input: {
      event: AuditEventName;
      actorPublicId: string;
      userPublicId: string | null;
      sessionPublicId: string | null;
      metadata: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await this.audit.writeMandatory(
      { connection },
      {
        event: input.event,
        actorPublicId: input.actorPublicId,
        userPublicId: input.userPublicId,
        sessionPublicId: input.sessionPublicId,
        subjectFingerprint: null,
        metadata: input.metadata,
      },
    );
  }

  async appendInvalidation(
    connection: PoolConnection,
    input: { boardPk: bigint; boardId: BoardId; nowSql: string },
  ): Promise<void> {
    const [headRows] = await connection.execute<ShareEventHeadRow[]>(
      `SELECT r.revision_id AS revisionId,
              CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
       FROM board_heads h
       JOIN board_revisions r
         ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
       WHERE h.board_pk = ?
       FOR UPDATE`,
      [input.boardPk.toString()],
    );
    const head = headRows[0];
    if (headRows.length !== 1 || head === undefined)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    const previousSequence = Number(head.lastEventSequence);
    const sequence = previousSequence + 1;
    if (
      !/^(?:0|[1-9][0-9]{0,15})$/u.test(head.lastEventSequence) ||
      !Number.isSafeInteger(previousSequence) ||
      !Number.isSafeInteger(sequence)
    ) {
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    }
    const event: BoardEventEnvelopeV1 = {
      protocolVersion: 1,
      type: 'board.event',
      boardId: input.boardId,
      eventId: this.generateUuid() as BoardEventEnvelopeV1['eventId'],
      sequence,
      occurredAt: timestamp(input.nowSql),
      revisionId: null,
      data: {
        type: 'stream.resync.required',
        durableHeadRevisionId: formatPublicUuidV4(head.revisionId) as RevisionId,
        lastUsableSequence: previousSequence,
        reason: 'server_reset',
      },
    };
    const parsed = BoardEventEnvelopeParserV1.parse(event);
    if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const payload = Buffer.from(parsed.data.canonicalBytes);
    const [headUpdated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_heads
       SET last_event_sequence = ?, updated_at = ?
       WHERE board_pk = ? AND last_event_sequence = ?`,
      [sequence, input.nowSql, input.boardPk.toString(), previousSequence],
    );
    if (headUpdated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const [outbox] = await connection.execute<ResultSetHeader>(
      `INSERT INTO board_event_outbox (
         event_id, board_pk, revision_pk, sequence_number, event_type,
         event_payload, event_canonical_bytes, event_sha256,
         status_code, occurred_at, delivered_at, retain_until
       ) VALUES (?, ?, NULL, ?, 'stream.resync.required', ?, ?, ?, 'P', ?, NULL, NULL)`,
      [
        Buffer.from(parsePublicUuidV4(event.eventId)),
        input.boardPk.toString(),
        sequence,
        payload,
        payload.byteLength,
        createHash('sha256').update(payload).digest(),
        input.nowSql,
      ],
    );
    insertedPk(outbox);
  }
}
