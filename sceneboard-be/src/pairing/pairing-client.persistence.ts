import type { ResultSetHeader } from 'mysql2/promise';

import { withTransaction } from '../database/transaction.js';
import {
  PairingCollisionError,
  PairingPersistenceContext,
  isDuplicateKey,
  type ClientStatusPersistenceInput,
  type ClientStatusPersistenceResult,
  type RedeemPairingPersistenceInput,
  type RedeemPairingPersistenceResult,
} from './pairing-persistence.context.js';

export class PairingClientPersistence extends PairingPersistenceContext {
  async clientStatus(input: ClientStatusPersistenceInput): Promise<ClientStatusPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const familyRows = await this.lockPairingFamily(connection, input.pairingId);
          const row = await this.lockClientPairing(connection, input.pairingId);
          if (!this.hasValidProof(row, input.proofChallenge))
            return { kind: 'proof_invalid' as const };

          if (row.state === 2 && this.timestampRequired(row.decisionExpiresAt) <= input.now) {
            await this.expireClaimedPairing(connection, row, input.now, 'decision_deadline');
            row.state = 7;
          } else if (row.state === 3) {
            await this.lockGrantForPairing(connection, row);
            const familyLive = this.hasLiveFamilySession(familyRows, input.now);
            const deadlineReached =
              this.timestampRequired(row.redeemExpiresAt) <= input.now ||
              this.timestampRequired(row.grantExpiresAt) <= input.now;
            if (!familyLive || deadlineReached) {
              await this.expireApprovedPairing(
                connection,
                row,
                input.now,
                familyLive ? 'deadline' : 'session_ended',
              );
              row.state = 7;
            } else if (row.grantStatus !== 1) {
              throw new Error('approved pairing has no pending grant');
            }
          }

          return {
            kind: 'status' as const,
            status: this.clientStatusFromRow(row, input.now),
          };
        }),
      );
    } catch {
      return { kind: 'service_unavailable' };
    }
  }

  async redeem(input: RedeemPairingPersistenceInput): Promise<RedeemPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const familyRows = await this.lockPairingFamily(connection, input.pairingId);
          const row = await this.lockClientPairing(connection, input.pairingId);
          if (!this.hasValidProof(row, input.proofChallenge))
            return { kind: 'proof_invalid' as const };

          if (row.state === 2) {
            if (this.timestampRequired(row.decisionExpiresAt) <= input.now) {
              await this.expireClaimedPairing(connection, row, input.now, 'decision_deadline');
              return { kind: 'terminal' as const };
            }
            return {
              kind: 'not_ready' as const,
              retryAfterSeconds: this.clientStatusFromRow(row, input.now).retryAfterSeconds as
                | 2
                | 5
                | 10,
            };
          }
          if (row.state !== 3) return { kind: 'terminal' as const };

          await this.lockGrantForPairing(connection, row);
          const familyLive = this.hasLiveFamilySession(familyRows, input.now);
          const deadlineReached =
            this.timestampRequired(row.redeemExpiresAt) <= input.now ||
            this.timestampRequired(row.grantExpiresAt) <= input.now;
          if (!familyLive || deadlineReached) {
            await this.expireApprovedPairing(
              connection,
              row,
              input.now,
              familyLive ? 'deadline' : 'session_ended',
            );
            return { kind: 'terminal' as const };
          }
          if (row.grantDatabaseId === null || row.grantStatus !== 1) {
            throw new Error('approved pairing has no pending grant');
          }

          await connection.execute(
            'SELECT id FROM mcp_grant_credentials WHERE grant_id = ? ORDER BY id FOR UPDATE',
            [row.grantDatabaseId],
          );
          const boardIds = await this.readGrantBoardIds(connection, row.grantDatabaseId);
          try {
            await connection.execute(
              `
            INSERT INTO mcp_grant_credentials (
              grant_id, locator, token_hash, status, created_at
            ) VALUES (?, ?, ?, 1, ?)
          `,
              [
                row.grantDatabaseId,
                input.credentialLocator,
                input.credentialHash,
                new Date(input.now),
              ],
            );
          } catch (error) {
            if (isDuplicateKey(error))
              throw new PairingCollisionError('grant credential locator collision');
            throw error;
          }
          const [activated] = await connection.execute<ResultSetHeader>(
            `
          UPDATE mcp_grants
          SET status = 2, activated_at = ?, updated_at = ?
          WHERE id = ? AND status = 1 AND expires_at > ?
        `,
            [new Date(input.now), new Date(input.now), row.grantDatabaseId, new Date(input.now)],
          );
          if (activated.affectedRows !== 1)
            throw new Error('grant activation compare-and-set failed');
          const [redeemed] = await connection.execute<ResultSetHeader>(
            `
          UPDATE pairing_requests
          SET state = 4, updated_at = ?
          WHERE id = ? AND state = 3 AND redeem_expires_at > ?
        `,
            [new Date(input.now), row.id, new Date(input.now)],
          );
          if (redeemed.affectedRows !== 1)
            throw new Error('pairing redemption compare-and-set failed');

          const lifetime =
            row.lifetime === 1 ? 'session' : row.lifetime === 2 ? 'persistent' : null;
          if (lifetime === null) throw new Error('approved pairing has invalid lifetime');
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'pairing_redeem',
              userPublicId: row.ownerUserPublicId,
              sessionPublicId: row.sourceSessionPublicId,
              clientPublicId: row.clientPublicId,
              grantPublicId: row.grantPublicId,
              pairingPublicId: row.publicId,
              subjectFingerprint: null,
              metadata: { lifetime },
            },
          );
          return {
            kind: 'redeemed' as const,
            grant: this.redeemedGrantFromRow(row, boardIds, input.now),
          };
        }),
      );
    } catch (error) {
      if (error instanceof PairingCollisionError) return { kind: 'collision' };
      return { kind: 'service_unavailable' };
    }
  }
}
