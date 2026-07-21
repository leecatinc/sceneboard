import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { PairingId } from '../common/ids/public-id.js';
import { withTransaction } from '../database/transaction.js';
import type { PairingOwnerStatus } from './pairing.status.js';
import {
  PairingPersistenceContext,
  type CancelPairingPersistenceResult,
  type OwnerPairingPersistenceInput,
  type OwnerPairingPersistenceResult,
} from './pairing-persistence.context.js';

export class PairingOwnerPersistence extends PairingPersistenceContext {
  async ownerStatus(input: OwnerPairingPersistenceInput): Promise<OwnerPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const familyRows = await this.lockPairingFamily(
            connection,
            input.pairingId,
            input.ownerUserDatabaseId,
          );
          const row = await this.lockClientPairing(
            connection,
            input.pairingId,
            input.ownerUserDatabaseId,
          );
          if (row === undefined) return { kind: 'not_found' as const };
          await this.applyOwnerLazyExpiry(connection, row, familyRows, input);
          const boardIds =
            row.approvedScopeMask === null || row.grantDatabaseId === null
              ? null
              : await this.readGrantBoardIds(connection, row.grantDatabaseId);
          return { kind: 'status' as const, status: this.ownerStatusFromRow(row, boardIds) };
        }),
      );
    } catch {
      return { kind: 'service_unavailable' };
    }
  }

  async listActive(
    input: Omit<OwnerPairingPersistenceInput, 'pairingId'>,
  ): Promise<PairingOwnerStatus[]> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const [links] = await connection.execute<
            Array<
              RowDataPacket & {
                pairingId: PairingId;
                familyPublicId: string;
              }
            >
          >(
            `
          SELECT p.public_id AS pairingId, s.family_public_id AS familyPublicId
          FROM pairing_requests p
          JOIN auth_sessions s ON s.id = p.source_session_id
          WHERE p.owner_user_id = ? AND p.state IN (1, 2, 3)
          ORDER BY p.id
          LIMIT 6
        `,
            [input.ownerUserDatabaseId],
          );
          if (links.length > 5) throw new Error('owner active pairing invariant exceeded');
          const familyIds = [...new Set(links.map((link) => link.familyPublicId))].sort();
          const familyRowsById = new Map<
            string,
            Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>
          >();
          if (familyIds.length > 0) {
            const placeholders = familyIds.map(() => '?').join(', ');
            const [familyRows] = await connection.execute<
              Array<
                RowDataPacket & {
                  familyPublicId: string;
                  status: number;
                  idleExpiresAt: string;
                  absoluteExpiresAt: string;
                }
              >
            >(
              `
            SELECT
              family_public_id AS familyPublicId,
              status,
              idle_expires_at AS idleExpiresAt,
              absolute_expires_at AS absoluteExpiresAt
            FROM auth_sessions
            WHERE family_public_id IN (${placeholders})
            ORDER BY family_public_id, id
            FOR UPDATE
          `,
              familyIds,
            );
            for (const family of familyRows) {
              const group = familyRowsById.get(family.familyPublicId) ?? [];
              group.push(family);
              familyRowsById.set(family.familyPublicId, group);
            }
          }

          const statuses: PairingOwnerStatus[] = [];
          for (const link of links) {
            const row = await this.lockClientPairing(
              connection,
              link.pairingId,
              input.ownerUserDatabaseId,
            );
            if (row === undefined || ![1, 2, 3].includes(row.state)) continue;
            await this.applyOwnerLazyExpiry(
              connection,
              row,
              familyRowsById.get(link.familyPublicId) ?? [],
              input,
            );
            if (![1, 2, 3].includes(row.state)) continue;
            const boardIds =
              row.approvedScopeMask === null || row.grantDatabaseId === null
                ? null
                : await this.readGrantBoardIds(connection, row.grantDatabaseId);
            statuses.push(this.ownerStatusFromRow(row, boardIds));
          }
          return statuses.sort(
            (left, right) =>
              right.createdAt.localeCompare(left.createdAt) ||
              right.pairingId.localeCompare(left.pairingId),
          );
        }),
      );
    } catch {
      throw new Error('pairing list is unavailable');
    }
  }

  async cancel(input: OwnerPairingPersistenceInput): Promise<CancelPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const familyRows = await this.lockPairingFamily(
            connection,
            input.pairingId,
            input.ownerUserDatabaseId,
          );
          const row = await this.lockClientPairing(
            connection,
            input.pairingId,
            input.ownerUserDatabaseId,
          );
          if (row === undefined) return { kind: 'not_found' as const };
          await this.applyOwnerLazyExpiry(connection, row, familyRows, input);
          if (row.state === 6) {
            await this.audit.writeMandatory(
              { connection },
              {
                event: 'pairing_cancel',
                userPublicId: input.ownerUserPublicId,
                sessionPublicId: input.sessionPublicId,
                clientPublicId: row.clientPublicId,
                grantPublicId: row.grantPublicId,
                pairingPublicId: row.publicId,
                subjectFingerprint: null,
                metadata: { reason: 'already_cancelled' },
              },
            );
            return { kind: 'cancelled' as const };
          }
          if (![1, 2, 3].includes(row.state)) return { kind: 'conflict' as const };

          if (row.state === 3) {
            if (
              row.grantDatabaseId === null ||
              row.grantPublicId === null ||
              row.grantStatus !== 1
            ) {
              throw new Error('approved pairing has no cancellable pending grant');
            }
            await connection.execute(
              'SELECT id FROM mcp_grant_credentials WHERE grant_id = ? ORDER BY id FOR UPDATE',
              [row.grantDatabaseId],
            );
            await connection.execute(
              `
            UPDATE mcp_grant_credentials SET status = 3, revoked_at = ?
            WHERE grant_id = ? AND status = 1
          `,
              [new Date(input.now), row.grantDatabaseId],
            );
            const [revoked] = await connection.execute<ResultSetHeader>(
              `
            UPDATE mcp_grants
            SET status = 3, revoked_at = ?, revoke_reason = 1, updated_at = ?
            WHERE id = ? AND status = 1
          `,
              [new Date(input.now), new Date(input.now), row.grantDatabaseId],
            );
            if (revoked.affectedRows !== 1)
              throw new Error('pending grant cancellation compare-and-set failed');
            await this.audit.writeMandatory(
              { connection },
              {
                event: 'grant_revoke',
                userPublicId: input.ownerUserPublicId,
                sessionPublicId: input.sessionPublicId,
                clientPublicId: row.clientPublicId,
                grantPublicId: row.grantPublicId,
                pairingPublicId: row.publicId,
                subjectFingerprint: null,
                metadata: { reason: 'owner' },
              },
            );
          }
          const [cancelled] = await connection.execute<ResultSetHeader>(
            `
          UPDATE pairing_requests
          SET state = 6, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
          WHERE id = ? AND owner_user_id = ? AND state IN (1, 2, 3)
        `,
            [new Date(input.now), row.id, input.ownerUserDatabaseId],
          );
          if (cancelled.affectedRows !== 1)
            throw new Error('pairing cancellation compare-and-set failed');
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'pairing_cancel',
              userPublicId: input.ownerUserPublicId,
              sessionPublicId: input.sessionPublicId,
              clientPublicId: row.clientPublicId,
              grantPublicId: row.grantPublicId,
              pairingPublicId: row.publicId,
              subjectFingerprint: null,
              metadata: { reason: 'owner' },
            },
          );
          return { kind: 'cancelled' as const };
        }),
      );
    } catch {
      return { kind: 'service_unavailable' };
    }
  }
}
