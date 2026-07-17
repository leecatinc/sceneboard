import { Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { PersistenceTransaction, SessionWriterPort } from './auth.persistence.js';
import type {
  SessionPersistence,
  SessionRecord,
  SessionStatus,
  SessionTerminalReason,
} from './session.service.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';

const connectionOf = (transaction: PersistenceTransaction): PoolConnection => transaction.connection as PoolConnection;

class SessionCollisionError extends Error {}

@Injectable()
export class SessionsRepository implements SessionWriterPort, SessionPersistence {
  constructor(
    @Inject(MysqlService) private readonly mysql: MysqlService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  async insert(transaction: PersistenceTransaction, input: Parameters<SessionWriterPort['insert']>[1]): Promise<void> {
    await connectionOf(transaction).execute(`
      INSERT INTO auth_sessions (
        public_id, family_public_id, user_id, token_locator, token_hash, status,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `, [
      input.sessionPublicId,
      input.familyPublicId,
      input.userDatabaseId,
      input.sessionTokenLocator,
      input.sessionTokenHash,
      new Date(input.now),
      new Date(input.now),
      new Date(input.idleExpiresAt),
      new Date(input.absoluteExpiresAt),
    ]);
  }

  async findByLocator(locator: Buffer): Promise<SessionRecord | null> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.execute<Array<RowDataPacket & {
        databaseId: string;
        publicId: string;
        familyPublicId: string;
        tokenHash: Buffer;
        status: number;
        userDatabaseId: string;
        userPublicId: string;
        email: string;
        userStatus: number;
        userCreatedAt: string;
        idleExpiresAt: string;
        absoluteExpiresAt: string;
      }>>(`
        SELECT
          CAST(s.id AS CHAR) AS databaseId,
          s.public_id AS publicId,
          s.family_public_id AS familyPublicId,
          s.token_hash AS tokenHash,
          s.status,
          CAST(u.id AS CHAR) AS userDatabaseId,
          u.public_id AS userPublicId,
          u.email,
          u.status AS userStatus,
          u.created_at AS userCreatedAt,
          s.idle_expires_at AS idleExpiresAt,
          s.absolute_expires_at AS absoluteExpiresAt
        FROM auth_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_locator = ?
        LIMIT 1
      `, [locator]);
      const row = rows[0];
      if (!row) return null;
      return {
        databaseId: row.databaseId,
        publicId: row.publicId,
        familyPublicId: row.familyPublicId,
        tokenHash: Buffer.from(row.tokenHash),
        status: mapSessionStatus(row.status),
        user: {
          databaseId: row.userDatabaseId,
          publicId: row.userPublicId,
          email: row.email,
          status: row.userStatus === 1 ? 'active' : 'disabled',
          createdAt: mysqlTimestampToIso(row.userCreatedAt),
        },
        idleExpiresAt: mysqlTimestampToMillis(row.idleExpiresAt),
        absoluteExpiresAt: mysqlTimestampToMillis(row.absoluteExpiresAt),
      };
    });
  }

  async terminalizeFamily(
    record: SessionRecord,
    reason: SessionTerminalReason,
    now: number,
  ): Promise<{ kind: 'committed' | 'audit_failed' }> {
    try {
      await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        await connection.execute(`
          SELECT id
          FROM auth_sessions
          WHERE family_public_id = ?
          ORDER BY id
          FOR UPDATE
        `, [record.familyPublicId]);
        const [pairingRows] = await connection.execute<Array<RowDataPacket & { id: string; grantId: string }>>(`
          SELECT CAST(p.id AS CHAR) AS id, CAST(p.grant_id AS CHAR) AS grantId
          FROM pairing_requests p
          JOIN auth_sessions s ON s.id = p.source_session_id
          WHERE s.family_public_id = ? AND p.state = 3
          ORDER BY p.id
          FOR UPDATE
        `, [record.familyPublicId]);
        const linkedGrantIds = pairingRows.map((row) => row.grantId);
        const linkedPredicate = linkedGrantIds.length === 0
          ? 'FALSE'
          : `g.id IN (${linkedGrantIds.map(() => '?').join(', ')})`;
        const [grantRows] = await connection.execute<Array<RowDataPacket & { id: string }>>(`
          SELECT DISTINCT CAST(g.id AS CHAR) AS id
          FROM mcp_grants g
          LEFT JOIN auth_sessions s ON s.id = g.source_session_id
          WHERE g.status IN (1, 2)
            AND ((g.lifetime = 1 AND s.family_public_id = ?) OR ${linkedPredicate})
          ORDER BY id
          FOR UPDATE
        `, [record.familyPublicId, ...linkedGrantIds]);
        const grantIds = grantRows.map((row) => row.id);
        if (grantIds.length > 0) {
          await connection.execute(`
            SELECT id
            FROM mcp_grant_credentials
            WHERE grant_id IN (${grantIds.map(() => '?').join(', ')})
            ORDER BY id
            FOR UPDATE
          `, grantIds);
        }
        const terminalStatus = reason === 'expired' ? 4 : 3;
        const revokeReason = reason === 'logout' ? 1 : reason === 'reuse' ? 3 : reason === 'disabled' ? 4 : 5;
        await connection.execute(`
          UPDATE auth_sessions
          SET status = ?, revoked_at = ?, revoke_reason = ?
          WHERE family_public_id = ? AND status = 1
        `, [terminalStatus, new Date(now), revokeReason, record.familyPublicId]);
        if (pairingRows.length > 0) {
          await connection.execute(`
            UPDATE pairing_requests
            SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
            WHERE id IN (${pairingRows.map(() => '?').join(', ')}) AND state = 3
          `, [new Date(now), ...pairingRows.map((row) => row.id)]);
        }
        if (grantIds.length > 0) {
          const placeholders = grantIds.map(() => '?').join(', ');
          await connection.execute(`
            UPDATE mcp_grant_credentials
            SET status = 3, revoked_at = ?
            WHERE grant_id IN (${placeholders}) AND status = 1
          `, [new Date(now), ...grantIds]);
          await connection.execute(`
            UPDATE mcp_grants
            SET status = 4, revoked_at = ?, revoke_reason = 2, updated_at = ?
            WHERE id IN (${placeholders}) AND status IN (1, 2)
          `, [new Date(now), new Date(now), ...grantIds]);
        }
        await this.audit.writeMandatory({ connection }, {
          event: reason === 'logout' ? 'session_logout' : reason === 'reuse' ? 'session_reuse' : 'session_revoke',
          userPublicId: record.user.publicId,
          sessionPublicId: record.publicId,
          subjectFingerprint: null,
          metadata: { reason },
        });
      }));
      return { kind: 'committed' };
    } catch {
      return { kind: 'audit_failed' };
    }
  }

  async observeLogout(record: SessionRecord): Promise<{ kind: 'committed' | 'audit_failed' }> {
    try {
      await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        await this.audit.writeMandatory({ connection }, {
          event: 'session_logout',
          userPublicId: record.user.publicId,
          sessionPublicId: record.publicId,
          subjectFingerprint: null,
          metadata: { reason: 'already_revoked' },
        });
      }));
      return { kind: 'committed' };
    } catch {
      return { kind: 'audit_failed' };
    }
  }

  async rotate(
    record: SessionRecord,
    replacement: Parameters<SessionPersistence['rotate']>[1],
  ): Promise<{ kind: 'created' | 'already_rotated' | 'public_id_collision' | 'audit_failed' }> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const [rows] = await connection.execute<Array<RowDataPacket & { status: number }>>(`
          SELECT status
          FROM auth_sessions
          WHERE id = ?
          FOR UPDATE
        `, [record.databaseId]);
        if (rows[0]?.status !== 1) return { kind: 'already_rotated' as const };
        await connection.execute(`
          UPDATE auth_sessions
          SET status = 2, rotated_at = ?
          WHERE id = ? AND status = 1
        `, [new Date(replacement.now), record.databaseId]);
        try {
          await connection.execute(`
            INSERT INTO auth_sessions (
              public_id, family_public_id, user_id, token_locator, token_hash, status,
              rotated_from_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          `, [
            replacement.publicId,
            replacement.familyPublicId,
            record.user.databaseId,
            replacement.locator,
            replacement.tokenHash,
            record.databaseId,
            new Date(replacement.now),
            new Date(replacement.now),
            new Date(replacement.idleExpiresAt),
            new Date(replacement.absoluteExpiresAt),
          ]);
        } catch (error) {
          if (isDuplicateKey(error)) throw new SessionCollisionError('session replacement collided');
          throw error;
        }
        await this.audit.writeMandatory({ connection }, {
          event: 'session_renew',
          userPublicId: record.user.publicId,
          sessionPublicId: replacement.publicId,
          subjectFingerprint: null,
          metadata: { reason: 'owner' },
        });
        return { kind: 'created' as const };
      }));
    } catch (error) {
      if (error instanceof SessionCollisionError) return { kind: 'public_id_collision' };
      return { kind: 'audit_failed' };
    }
  }
}

const mapSessionStatus = (value: number): SessionStatus => {
  if (value === 1) return 'active';
  if (value === 2) return 'rotated';
  if (value === 3) return 'revoked';
  if (value === 4) return 'expired';
  throw new Error('database returned an invalid session status');
};

const mysqlTimestampToMillis = (value: string): number => {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isSafeInteger(parsed)) throw new Error('database returned an invalid timestamp');
  return parsed;
};

const mysqlTimestampToIso = (value: string): string => new Date(mysqlTimestampToMillis(value)).toISOString();

const isDuplicateKey = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
);
