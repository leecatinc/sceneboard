import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { ShareContractError } from '../common/errors/app-error.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { PasswordHashRecord } from './password-hash.service.js';
import type { LockedShare, LockedShareCredential, ShareRepository } from './share.repository.js';

interface ClockRow extends RowDataPacket {
  nowSql: string;
}

interface FamilyRow extends RowDataPacket {
  expiresAt: string;
}

interface GrantRow extends RowDataPacket {
  accessGeneration: string;
  credentialVersion: string;
  expiresAt: string;
}

export type PasswordGrantState = {
  accessGeneration: number;
  credentialVersion: number;
  expiresAtSql: string;
};

const affectedOne = (result: ResultSetHeader): void => {
  if (result.affectedRows !== 1) throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
};

export const passwordDatabaseNow = async (connection: PoolConnection): Promise<string> => {
  const [rows] = await connection.execute<ClockRow[]>('SELECT UTC_TIMESTAMP(3) AS nowSql');
  const nowSql = rows[0]?.nowSql;
  if (nowSql === undefined) throw new ShareContractError('SERVICE_UNAVAILABLE', 1);
  parseMysqlTimestampUtc(nowSql);
  return nowSql;
};

export class PasswordShareRepository {
  constructor(private readonly shares: ShareRepository) {}

  async enable(
    connection: PoolConnection,
    share: LockedShare,
    hash: PasswordHashRecord,
    nowSql: string,
  ): Promise<LockedShare> {
    const accessGeneration = this.shares.nextGeneration(share.accessGeneration);
    const version = this.shares.nextGeneration(share.version);
    const [credential] = await connection.execute<ResultSetHeader>(
      `INSERT INTO share_password_credentials (
         share_pk, password_hash, salt, hash_version, pepper_version,
         credential_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        share.sharePk.toString(),
        hash.passwordHash,
        hash.salt,
        hash.hashVersion,
        hash.pepperVersion,
        nowSql,
        nowSql,
      ],
    );
    affectedOne(credential);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET access_policy = 'P', access_generation = ?, version = ?, updated_at = ?
       WHERE share_pk = ? AND status = 'active' AND access_policy = 'L' AND version = ?`,
      [accessGeneration, version, nowSql, share.sharePk.toString(), share.version],
    );
    affectedOne(updated);
    return (await this.shares.lockShare(connection, share.boardPk))!;
  }

  async regenerate(
    connection: PoolConnection,
    share: LockedShare,
    hash: PasswordHashRecord,
    nowSql: string,
  ): Promise<LockedShare> {
    const credential = share.credential;
    if (credential === null) throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
    const credentialVersion = this.shares.nextGeneration(credential.credentialVersion);
    const accessGeneration = this.shares.nextGeneration(share.accessGeneration);
    const version = this.shares.nextGeneration(share.version);
    await this.shares.invalidatePasswordAccess(connection, share.sharePk, false);
    const [credentialUpdated] = await connection.execute<ResultSetHeader>(
      `UPDATE share_password_credentials
       SET password_hash = ?, salt = ?, hash_version = ?, pepper_version = ?,
           credential_version = ?, updated_at = ?
       WHERE share_pk = ? AND credential_version = ?`,
      [
        hash.passwordHash,
        hash.salt,
        hash.hashVersion,
        hash.pepperVersion,
        credentialVersion,
        nowSql,
        share.sharePk.toString(),
        credential.credentialVersion,
      ],
    );
    affectedOne(credentialUpdated);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET access_generation = ?, version = ?, updated_at = ?
       WHERE share_pk = ? AND status = 'active' AND access_policy = 'P' AND version = ?`,
      [accessGeneration, version, nowSql, share.sharePk.toString(), share.version],
    );
    affectedOne(updated);
    return (await this.shares.lockShare(connection, share.boardPk))!;
  }

  async disable(
    connection: PoolConnection,
    share: LockedShare,
    nowSql: string,
  ): Promise<LockedShare> {
    if (share.accessPolicy === 'L' && share.credential === null) return share;
    if (share.accessPolicy !== 'P' || share.credential === null) {
      throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
    }
    const accessGeneration = this.shares.nextGeneration(share.accessGeneration);
    const version = this.shares.nextGeneration(share.version);
    await this.shares.invalidatePasswordAccess(connection, share.sharePk, true);
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE board_shares
       SET access_policy = 'L', access_generation = ?, version = ?, updated_at = ?
       WHERE share_pk = ? AND status = 'active' AND access_policy = 'P' AND version = ?`,
      [accessGeneration, version, nowSql, share.sharePk.toString(), share.version],
    );
    affectedOne(updated);
    return (await this.shares.lockShare(connection, share.boardPk))!;
  }

  async createFamily(connection: PoolConnection, digest: Buffer, nowSql: string): Promise<string> {
    const [created] = await connection.execute<ResultSetHeader>(
      `INSERT INTO share_password_session_families (
         family_digest, expires_at, created_at
       ) VALUES (?, ? + INTERVAL 30 MINUTE, ?)`,
      [digest, nowSql, nowSql],
    );
    affectedOne(created);
    return this.lockFamily(connection, digest, nowSql).then((value) => value!);
  }

  async lockFamily(
    connection: PoolConnection,
    digest: Buffer,
    nowSql: string,
  ): Promise<string | null> {
    const [rows] = await connection.execute<FamilyRow[]>(
      `SELECT expires_at AS expiresAt
       FROM share_password_session_families
       WHERE family_digest = ? AND expires_at > ?
       LIMIT 1 FOR UPDATE`,
      [digest, nowSql],
    );
    if (rows.length === 0) return null;
    const expiresAt = rows[0]!.expiresAt;
    parseMysqlTimestampUtc(expiresAt);
    return expiresAt;
  }

  async upsertGrant(
    connection: PoolConnection,
    input: {
      familyDigest: Buffer;
      share: LockedShare;
      credential: LockedShareCredential;
      familyExpiresAtSql: string;
      nowSql: string;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO share_password_session_grants (
         family_digest, share_pk, access_generation, credential_version,
         expires_at, created_at
       ) VALUES (
         ?, ?, ?, ?,
         LEAST(?, ? + INTERVAL 30 MINUTE), ?
       )
       ON DUPLICATE KEY UPDATE
         access_generation = VALUES(access_generation),
         credential_version = VALUES(credential_version),
         expires_at = VALUES(expires_at),
         created_at = VALUES(created_at)`,
      [
        input.familyDigest,
        input.share.sharePk.toString(),
        input.share.accessGeneration,
        input.credential.credentialVersion,
        input.familyExpiresAtSql,
        input.nowSql,
        input.nowSql,
      ],
    );
    if (result.affectedRows < 1 || result.affectedRows > 2) {
      throw new ShareContractError('SERVICE_UNAVAILABLE', 1);
    }
  }

  async lockGrant(
    connection: PoolConnection,
    input: {
      familyDigest: Buffer;
      sharePk: bigint;
      nowSql: string;
    },
  ): Promise<PasswordGrantState | null> {
    const [rows] = await connection.execute<GrantRow[]>(
      `SELECT CAST(g.access_generation AS CHAR) AS accessGeneration,
              CAST(g.credential_version AS CHAR) AS credentialVersion,
              g.expires_at AS expiresAt
       FROM share_password_session_grants g
       JOIN share_password_session_families f
         ON f.family_digest = g.family_digest
       WHERE g.family_digest = ? AND g.share_pk = ?
         AND g.expires_at > ? AND f.expires_at > ?
       LIMIT 1 FOR UPDATE`,
      [input.familyDigest, input.sharePk.toString(), input.nowSql, input.nowSql],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) return null;
    const accessGeneration = Number(row.accessGeneration);
    const credentialVersion = Number(row.credentialVersion);
    if (
      !Number.isSafeInteger(accessGeneration) ||
      accessGeneration < 1 ||
      !Number.isSafeInteger(credentialVersion) ||
      credentialVersion < 1
    ) {
      throw new ShareContractError('BOARD_NOT_FOUND');
    }
    parseMysqlTimestampUtc(row.expiresAt);
    return { accessGeneration, credentialVersion, expiresAtSql: row.expiresAt };
  }

  async lockGrantState(
    connection: PoolConnection,
    input: { familyDigest: Buffer; sharePk: bigint },
  ): Promise<PasswordGrantState | null> {
    const [rows] = await connection.execute<GrantRow[]>(
      `SELECT CAST(access_generation AS CHAR) AS accessGeneration,
              CAST(credential_version AS CHAR) AS credentialVersion,
              expires_at AS expiresAt
       FROM share_password_session_grants
       WHERE family_digest = ? AND share_pk = ?
       LIMIT 1 FOR UPDATE`,
      [input.familyDigest, input.sharePk.toString()],
    );
    const row = rows[0];
    if (rows.length === 0 || row === undefined) return null;
    if (rows.length !== 1) throw new ShareContractError('SERVICE_UNAVAILABLE', 1);
    const accessGeneration = Number(row.accessGeneration);
    const credentialVersion = Number(row.credentialVersion);
    if (
      !Number.isSafeInteger(accessGeneration) ||
      accessGeneration < 1 ||
      !Number.isSafeInteger(credentialVersion) ||
      credentialVersion < 1
    )
      throw new ShareContractError('SERVICE_UNAVAILABLE', 1);
    parseMysqlTimestampUtc(row.expiresAt);
    return { accessGeneration, credentialVersion, expiresAtSql: row.expiresAt };
  }

  async cleanupExpired(
    connection: PoolConnection,
    input: { owner: Buffer; expectedFence?: number | undefined },
  ): Promise<{ fence: number; grants: number; families: number }> {
    const [claim] = await connection.execute<ResultSetHeader>(
      `UPDATE share_password_cleanup_leases
       SET lease_owner = ?, lease_expires_at = CURRENT_TIMESTAMP(6) + INTERVAL 60 SECOND,
           fence = fence + 1
       WHERE name = _binary 'share-password-sessions'
         AND fence < 9007199254740991
         AND (
           lease_owner = ?
           OR lease_expires_at IS NULL
           OR lease_expires_at <= CURRENT_TIMESTAMP(6)
         )`,
      [input.owner, input.owner],
    );
    if (claim.affectedRows !== 1)
      return { fence: input.expectedFence ?? 0, grants: 0, families: 0 };
    const [leaseRows] = await connection.execute<Array<RowDataPacket & { fence: string }>>(
      `SELECT CAST(fence AS CHAR) AS fence
       FROM share_password_cleanup_leases
       WHERE name = _binary 'share-password-sessions' AND lease_owner = ?
       FOR UPDATE`,
      [input.owner],
    );
    const fence = Number(leaseRows[0]?.fence);
    if (!Number.isSafeInteger(fence) || fence < 1) {
      throw new ShareContractError('SERVICE_UNAVAILABLE', 1);
    }
    const [grants] = await connection.execute<ResultSetHeader>(
      `DELETE FROM share_password_session_grants
       WHERE (family_digest, share_pk) IN (
         SELECT expired.family_digest, expired.share_pk
         FROM (
           SELECT g.family_digest, g.share_pk
           FROM share_password_session_grants g
           JOIN share_password_cleanup_leases l
             ON l.name = _binary 'share-password-sessions'
            AND l.lease_owner = ? AND l.fence = ?
            AND l.lease_expires_at > CURRENT_TIMESTAMP(6)
           WHERE g.expires_at <= CURRENT_TIMESTAMP(6)
           ORDER BY g.expires_at, g.family_digest, g.share_pk
           LIMIT 1000
         ) expired
       )`,
      [input.owner, fence],
    );
    const [families] = await connection.execute<ResultSetHeader>(
      `DELETE FROM share_password_session_families
       WHERE family_digest IN (
         SELECT expired.family_digest
         FROM (
           SELECT f.family_digest
           FROM share_password_session_families f
           JOIN share_password_cleanup_leases l
             ON l.name = _binary 'share-password-sessions'
            AND l.lease_owner = ? AND l.fence = ?
            AND l.lease_expires_at > CURRENT_TIMESTAMP(6)
           LEFT JOIN share_password_session_grants g
             ON g.family_digest = f.family_digest
           WHERE f.expires_at <= CURRENT_TIMESTAMP(6) AND g.family_digest IS NULL
           ORDER BY f.expires_at, f.family_digest
           LIMIT 1000
         ) expired
       )`,
      [input.owner, fence],
    );
    return { fence, grants: grants.affectedRows, families: families.affectedRows };
  }
}
