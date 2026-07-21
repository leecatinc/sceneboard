import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { PairingId } from '../common/ids/public-id.js';
import { withTransaction } from '../database/transaction.js';
import {
  PairingCollisionError,
  PairingPersistenceContext,
  isDuplicateKey,
  mysqlTimestampToMillis,
  type ClaimPairingPersistenceInput,
  type ClaimPairingPersistenceResult,
  type CreatePairingPersistenceInput,
  type CreatePairingPersistenceResult,
} from './pairing-persistence.context.js';

export class PairingRequestPersistence extends PairingPersistenceContext {
  async create(input: CreatePairingPersistenceInput): Promise<CreatePairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const [users] = await connection.execute<Array<RowDataPacket & { status: number }>>(
            'SELECT status FROM users WHERE id = ? FOR UPDATE',
            [input.ownerUserDatabaseId],
          );
          if (users[0]?.status !== 1) return { kind: 'unavailable' as const };
          const [sessions] = await connection.execute<
            Array<
              RowDataPacket & {
                status: number;
                idleExpiresAt: string;
                absoluteExpiresAt: string;
              }
            >
          >(
            `
          SELECT status, idle_expires_at AS idleExpiresAt, absolute_expires_at AS absoluteExpiresAt
          FROM auth_sessions
          WHERE id = ? AND user_id = ?
          FOR UPDATE
        `,
            [input.sourceSessionDatabaseId, input.ownerUserDatabaseId],
          );
          const session = sessions[0];
          if (
            session?.status !== 1 ||
            mysqlTimestampToMillis(session.idleExpiresAt) <= input.now ||
            mysqlTimestampToMillis(session.absoluteExpiresAt) <= input.now
          )
            return { kind: 'unavailable' as const };

          await this.expireDuePairings(
            connection,
            input.ownerUserDatabaseId,
            input.ownerUserPublicId,
            input.now,
          );
          const [quotaRows] = await connection.execute<
            Array<
              RowDataPacket & {
                activeCount: string;
                earliestDeadline: string | null;
              }
            >
          >(
            `
          SELECT
            CAST(COUNT(*) AS CHAR) AS activeCount,
            MIN(CASE
              WHEN state = 1 THEN code_expires_at
              WHEN state = 2 THEN decision_expires_at
              ELSE redeem_expires_at
            END) AS earliestDeadline
          FROM pairing_requests
          WHERE owner_user_id = ? AND state IN (1, 2, 3)
        `,
            [input.ownerUserDatabaseId],
          );
          const quota = quotaRows[0];
          if (Number(quota?.activeCount ?? 0) >= 5) {
            const retryAt =
              quota?.earliestDeadline === null || quota?.earliestDeadline === undefined
                ? input.now + 1_000
                : mysqlTimestampToMillis(quota.earliestDeadline);
            return {
              kind: 'quota' as const,
              retryAfterSeconds: Math.max(1, Math.ceil((retryAt - input.now) / 1_000)),
            };
          }

          try {
            await connection.execute(
              `
            INSERT INTO pairing_requests (
              public_id, owner_user_id, source_session_id,
              code_locator_hash, code_verifier_hash, state,
              matched_failure_count, code_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
          `,
              [
                input.publicId,
                input.ownerUserDatabaseId,
                input.sourceSessionDatabaseId,
                input.locatorHash,
                input.verifierHash,
                new Date(input.codeExpiresAt),
                new Date(input.now),
                new Date(input.now),
              ],
            );
          } catch (error) {
            if (isDuplicateKey(error))
              throw new PairingCollisionError('pairing identifier collision');
            throw error;
          }
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'pairing_create',
              userPublicId: input.ownerUserPublicId,
              sessionPublicId: input.sourceSessionPublicId,
              subjectFingerprint: null,
              pairingPublicId: input.publicId,
              metadata: { state: 'created' },
            },
          );
          return { kind: 'created' as const };
        }),
      );
    } catch (error) {
      if (error instanceof PairingCollisionError) return { kind: 'collision' };
      return { kind: 'unavailable' };
    }
  }

  async claim(input: ClaimPairingPersistenceInput): Promise<ClaimPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const [rows] = await connection.execute<
            Array<
              RowDataPacket & {
                id: string;
                publicId: PairingId;
                ownerUserDatabaseId: string;
                ownerUserPublicId: string;
                sourceSessionPublicId: string;
                verifierHash: Buffer;
                state: number;
                matchedFailureCount: number;
                codeExpiresAt: string;
              }
            >
          >(
            `
          SELECT
            CAST(p.id AS CHAR) AS id,
            p.public_id AS publicId,
            CAST(p.owner_user_id AS CHAR) AS ownerUserDatabaseId,
            u.public_id AS ownerUserPublicId,
            s.public_id AS sourceSessionPublicId,
            p.code_verifier_hash AS verifierHash,
            p.state,
            p.matched_failure_count AS matchedFailureCount,
            p.code_expires_at AS codeExpiresAt
          FROM pairing_requests p
          JOIN users u ON u.id = p.owner_user_id
          JOIN auth_sessions s ON s.id = p.source_session_id
          WHERE p.code_locator_hash = ?
          LIMIT 1
          FOR UPDATE
        `,
            [input.locatorHash],
          );
          const row = rows[0];
          if (!row || row.state !== 1 || row.matchedFailureCount >= 5)
            return { kind: 'unavailable' as const };
          if (mysqlTimestampToMillis(row.codeExpiresAt) <= input.now) {
            const [expired] = await connection.execute<ResultSetHeader>(
              `
            UPDATE pairing_requests
            SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
            WHERE id = ? AND state = 1 AND code_expires_at <= ?
          `,
              [new Date(input.now), row.id, new Date(input.now)],
            );
            if (expired.affectedRows !== 1)
              throw new Error('pairing expiry compare-and-set failed');
            await this.audit.writeMandatory(
              { connection },
              {
                event: 'pairing_expire',
                userPublicId: row.ownerUserPublicId,
                sessionPublicId: row.sourceSessionPublicId,
                subjectFingerprint: null,
                pairingPublicId: row.publicId,
                metadata: { reason: 'code_deadline' },
              },
            );
            return { kind: 'unavailable' as const };
          }
          if (!this.crypto.constantTimeEqual(input.verifierHash, row.verifierHash)) {
            const nextFailureCount = row.matchedFailureCount + 1;
            const [failed] = await connection.execute<ResultSetHeader>(
              `
            UPDATE pairing_requests
            SET
              matched_failure_count = ?,
              state = ?,
              code_locator_hash = IF(? = 8, NULL, code_locator_hash),
              code_verifier_hash = IF(? = 8, NULL, code_verifier_hash),
              updated_at = ?
            WHERE id = ? AND state = 1 AND code_expires_at > ? AND matched_failure_count = ?
          `,
              [
                nextFailureCount,
                nextFailureCount === 5 ? 8 : 1,
                nextFailureCount === 5 ? 8 : 1,
                nextFailureCount === 5 ? 8 : 1,
                new Date(input.now),
                row.id,
                new Date(input.now),
                row.matchedFailureCount,
              ],
            );
            if (failed.affectedRows !== 1)
              throw new Error('pairing failure compare-and-set failed');
            if (nextFailureCount === 5) {
              await this.audit.writeMandatory(
                { connection },
                {
                  event: 'pairing_lock',
                  userPublicId: row.ownerUserPublicId,
                  sessionPublicId: row.sourceSessionPublicId,
                  subjectFingerprint: null,
                  pairingPublicId: row.publicId,
                  metadata: { reason: 'attempt_limit' },
                },
              );
            }
            return { kind: 'unavailable' as const };
          }

          const clientId = await this.upsertClient(connection, row.ownerUserDatabaseId, input);
          const [claimed] = await connection.execute<ResultSetHeader>(
            `
          UPDATE pairing_requests
          SET
            state = 2,
            client_id = ?,
            code_locator_hash = NULL,
            code_verifier_hash = NULL,
            client_proof_challenge = ?,
            requested_scope_mask = ?,
            requested_lifecycle_mask = ?,
            claimed_at = ?,
            decision_expires_at = ?,
            updated_at = ?
          WHERE id = ? AND state = 1 AND code_expires_at > ?
            AND matched_failure_count < 5
            AND code_locator_hash IS NOT NULL AND code_verifier_hash IS NOT NULL
        `,
            [
              clientId,
              input.clientProofChallenge,
              input.requestedScopeMask,
              input.requestedLifecycleMask,
              new Date(input.now),
              new Date(input.decisionExpiresAt),
              new Date(input.now),
              row.id,
              new Date(input.now),
            ],
          );
          if (claimed.affectedRows !== 1) throw new Error('pairing claim compare-and-set failed');
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'pairing_claim',
              userPublicId: row.ownerUserPublicId,
              sessionPublicId: row.sourceSessionPublicId,
              subjectFingerprint: null,
              clientPublicId: input.clientPublicId,
              pairingPublicId: row.publicId,
              metadata: { state: 'pending' },
            },
          );
          return { kind: 'claimed' as const, pairingId: row.publicId };
        }),
      );
    } catch (error) {
      if (error instanceof PairingCollisionError) return { kind: 'collision' };
      return { kind: 'service_unavailable' };
    }
  }
}
