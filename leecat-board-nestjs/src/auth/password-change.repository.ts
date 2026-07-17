import { Inject, Injectable } from '@nestjs/common';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type {
  CommitPasswordChangeInput,
  CommitPasswordChangeResult,
  PasswordChangeCandidate,
  PasswordChangePersistence,
} from './password-change.service.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';

@Injectable()
export class PasswordChangeRepository implements PasswordChangePersistence {
  constructor(
    @Inject(MysqlService) private readonly mysql: MysqlService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  async findCandidate(userDatabaseId: string): Promise<PasswordChangeCandidate | null> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.execute<Array<RowDataPacket & {
        passwordHash: string;
        status: number;
      }>>(`
        SELECT password_hash AS passwordHash, status
        FROM users
        WHERE id = ?
        LIMIT 1
      `, [userDatabaseId]);
      const row = rows[0];
      if (!row) return null;
      if (row.status !== 1 && row.status !== 2) throw new Error('database returned an invalid user status');
      return { passwordHash: row.passwordHash, status: row.status === 1 ? 'active' : 'disabled' };
    });
  }

  async commit(input: CommitPasswordChangeInput): Promise<CommitPasswordChangeResult> {
    return this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
      const [userRows] = await connection.execute<Array<RowDataPacket & {
        passwordHash: string;
        status: number;
      }>>(`
        SELECT password_hash AS passwordHash, status
        FROM users
        WHERE id = ?
        FOR UPDATE
      `, [input.userDatabaseId]);
      const user = userRows[0];
      if (!user || user.passwordHash !== input.expectedPasswordHash) return { kind: 'stale_hash' as const };
      if (user.status !== 1) return { kind: 'disabled' as const };

      const [sessionRows] = await connection.execute<Array<RowDataPacket & {
        databaseId: string;
        familyPublicId: string;
        status: number;
      }>>(`
        SELECT CAST(id AS CHAR) AS databaseId, family_public_id AS familyPublicId, status
        FROM auth_sessions
        WHERE user_id = ?
        ORDER BY id
        FOR UPDATE
      `, [input.userDatabaseId]);
      const currentSession = sessionRows.find((row) => row.databaseId === input.currentSessionDatabaseId);
      if (
        !currentSession
        || currentSession.status !== 1
        || currentSession.familyPublicId !== input.currentFamilyPublicId
      ) return { kind: 'session_stale' as const };

      const otherSessionFamilies = new Set(
        sessionRows
          .filter((row) => row.status === 1 && row.familyPublicId !== input.currentFamilyPublicId)
          .map((row) => row.familyPublicId),
      );
      const [pairingRows] = await connection.execute<Array<RowDataPacket & {
        id: string;
        grantId: string;
      }>>(`
        SELECT CAST(p.id AS CHAR) AS id, CAST(p.grant_id AS CHAR) AS grantId
        FROM pairing_requests p
        JOIN auth_sessions s ON s.id = p.source_session_id
        WHERE s.user_id = ? AND s.family_public_id <> ? AND p.state = 3
        ORDER BY p.id
        FOR UPDATE
      `, [input.userDatabaseId, input.currentFamilyPublicId]);
      const linkedGrantIds = pairingRows.map((row) => row.grantId);
      const linkedPredicate = linkedGrantIds.length === 0
        ? 'FALSE'
        : `g.id IN (${linkedGrantIds.map(() => '?').join(', ')})`;
      const [grantRows] = await connection.execute<Array<RowDataPacket & { id: string }>>(`
        SELECT DISTINCT CAST(g.id AS CHAR) AS id
        FROM mcp_grants g
        LEFT JOIN auth_sessions s ON s.id = g.source_session_id
        WHERE g.status IN (1, 2)
          AND (
            (g.lifetime = 1 AND s.user_id = ? AND s.family_public_id <> ?)
            OR ${linkedPredicate}
          )
        ORDER BY id
        FOR UPDATE
      `, [input.userDatabaseId, input.currentFamilyPublicId, ...linkedGrantIds]);
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

      const [updated] = await connection.execute<ResultSetHeader>(`
        UPDATE users
        SET password_hash = ?, password_updated_at = ?, updated_at = ?
        WHERE id = ? AND password_hash = ? AND status = 1
      `, [
        input.replacementPasswordHash,
        new Date(input.now),
        new Date(input.now),
        input.userDatabaseId,
        input.expectedPasswordHash,
      ]);
      if (updated.affectedRows !== 1) throw new Error('locked user password hash changed unexpectedly');

      await connection.execute(`
        UPDATE auth_sessions
        SET status = 3, revoked_at = ?, revoke_reason = 2
        WHERE user_id = ? AND family_public_id <> ? AND status = 1
      `, [new Date(input.now), input.userDatabaseId, input.currentFamilyPublicId]);
      if (pairingRows.length > 0) {
        await connection.execute(`
          UPDATE pairing_requests
          SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
          WHERE id IN (${pairingRows.map(() => '?').join(', ')}) AND state = 3
        `, [new Date(input.now), ...pairingRows.map((row) => row.id)]);
      }
      if (grantIds.length > 0) {
        const placeholders = grantIds.map(() => '?').join(', ');
        await connection.execute(`
          UPDATE mcp_grant_credentials
          SET status = 3, revoked_at = ?
          WHERE grant_id IN (${placeholders}) AND status = 1
        `, [new Date(input.now), ...grantIds]);
        await connection.execute(`
          UPDATE mcp_grants
          SET status = 4, revoked_at = ?, revoke_reason = 2, updated_at = ?
          WHERE id IN (${placeholders}) AND status IN (1, 2)
        `, [new Date(input.now), new Date(input.now), ...grantIds]);
      }
      await this.audit.writeMandatory({ connection }, {
        event: 'password_change',
        userPublicId: input.userPublicId,
        sessionPublicId: input.currentSessionPublicId,
        subjectFingerprint: null,
        metadata: { otherSessionFamiliesRevoked: otherSessionFamilies.size },
      });
      return { kind: 'changed' as const, otherSessionFamiliesRevoked: otherSessionFamilies.size };
    }));
  }
}
