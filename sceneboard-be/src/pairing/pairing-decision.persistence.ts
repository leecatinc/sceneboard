import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { BoardId } from '@sceneboard/board-schema';
import type { PairingId } from '../common/ids/public-id.js';
import { BoardCreateIdentifierCollisionError } from '../boards/board-create.service.js';
import { withTransaction } from '../database/transaction.js';
import { lifecycleValuesFromMask, scopeValuesFromMask } from '../grants/scope-map.js';
import {
  PairingCollisionError,
  PairingPersistenceContext,
  isDuplicateKey,
  mysqlTimestampToMillis,
  type DecidePairingPersistenceInput,
  type DecidePairingPersistenceResult,
} from './pairing-persistence.context.js';

export class PairingDecisionPersistence extends PairingPersistenceContext {
  async decide(input: DecidePairingPersistenceInput): Promise<DecidePairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const [users] = await connection.execute<Array<RowDataPacket & { status: number }>>(
            'SELECT status FROM users WHERE id = ? FOR UPDATE',
            [input.ownerUserDatabaseId],
          );
          if (users[0]?.status !== 1) return { kind: 'service_unavailable' as const };
          const [familyRows] = await connection.execute<
            Array<
              RowDataPacket & {
                id: string;
                status: number;
                idleExpiresAt: string;
                absoluteExpiresAt: string;
              }
            >
          >(
            `
          SELECT
            CAST(id AS CHAR) AS id,
            status,
            idle_expires_at AS idleExpiresAt,
            absolute_expires_at AS absoluteExpiresAt
          FROM auth_sessions
          WHERE family_public_id = ?
          ORDER BY id
          FOR UPDATE
        `,
            [input.approvingFamilyPublicId],
          );
          const approvingSession = familyRows.find(
            (row) => row.id === input.approvingSessionDatabaseId,
          );
          if (
            approvingSession?.status !== 1 ||
            mysqlTimestampToMillis(approvingSession.idleExpiresAt) <= input.now ||
            mysqlTimestampToMillis(approvingSession.absoluteExpiresAt) <= input.now
          )
            return { kind: 'service_unavailable' as const };

          const [rows] = await connection.execute<
            Array<
              RowDataPacket & {
                id: string;
                publicId: PairingId;
                state: number;
                requestedScopeMask: number;
                requestedLifecycleMask: number;
                clientDatabaseId: string;
                clientPublicId: string;
                clientName: string;
                installationId: string;
                createdAt: string;
                codeExpiresAt: string;
                decisionExpiresAt: string;
              }
            >
          >(
            `
          SELECT
            CAST(p.id AS CHAR) AS id,
            p.public_id AS publicId,
            p.state,
            p.requested_scope_mask AS requestedScopeMask,
            p.requested_lifecycle_mask AS requestedLifecycleMask,
            CAST(p.client_id AS CHAR) AS clientDatabaseId,
            c.public_id AS clientPublicId,
            c.display_name AS clientName,
            c.installation_id AS installationId,
            p.created_at AS createdAt,
            p.code_expires_at AS codeExpiresAt,
            p.decision_expires_at AS decisionExpiresAt
          FROM pairing_requests p
          LEFT JOIN mcp_clients c ON c.id = p.client_id
          WHERE p.public_id = ? AND p.owner_user_id = ?
          LIMIT 1
          FOR UPDATE
        `,
            [input.pairingId, input.ownerUserDatabaseId],
          );
          const row = rows[0];
          if (!row) return { kind: 'not_found' as const };
          if (row.state !== 2) return { kind: 'conflict' as const };
          if (mysqlTimestampToMillis(row.decisionExpiresAt) <= input.now) {
            await this.expirePendingDecision(connection, row, input);
            return { kind: 'conflict' as const };
          }

          if (input.decision === 'deny') {
            const [denied] = await connection.execute<ResultSetHeader>(
              `
            UPDATE pairing_requests
            SET state = 5, decided_at = ?, updated_at = ?
            WHERE id = ? AND owner_user_id = ? AND state = 2 AND decision_expires_at > ?
          `,
              [
                new Date(input.now),
                new Date(input.now),
                row.id,
                input.ownerUserDatabaseId,
                new Date(input.now),
              ],
            );
            if (denied.affectedRows !== 1) return { kind: 'conflict' as const };
            await this.audit.writeMandatory(
              { connection },
              {
                event: 'pairing_deny',
                userPublicId: input.ownerUserPublicId,
                sessionPublicId: input.approvingSessionPublicId,
                pairingPublicId: row.publicId,
                clientPublicId: row.clientPublicId,
                subjectFingerprint: null,
                metadata: { reason: 'owner' },
              },
            );
            return {
              kind: 'decided' as const,
              status: this.decisionStatus(row, input, null, null, null, 5, null),
            };
          }

          if (
            (input.approvedScopeMask & row.requestedScopeMask) !== input.approvedScopeMask ||
            (input.approvedLifecycleMask & row.requestedLifecycleMask) !==
              input.approvedLifecycleMask
          )
            return { kind: 'scope_invalid' as const };
          const approvedScopes = scopeValuesFromMask(input.approvedScopeMask);
          const approvedLifecyclePermissions = lifecycleValuesFromMask(input.approvedLifecycleMask);
          if (
            (input.destination.mode === 'create' || input.destination.mode === 'deferred') &&
            (!approvedScopes.includes('board.write') ||
              !approvedLifecyclePermissions.includes('board.create'))
          )
            return { kind: 'scope_invalid' as const };

          let boardIds: BoardId[];
          if (input.destination.mode === 'existing') {
            const [boardRows] = await connection.execute<
              Array<RowDataPacket & { publicId: BoardId }>
            >(
              `
            SELECT public_id AS publicId
            FROM boards
            WHERE owner_user_id = ? AND public_id = ?
            FOR UPDATE
          `,
              [input.ownerUserDatabaseId, input.destination.boardId],
            );
            if (boardRows.length !== 1 || boardRows[0]?.publicId !== input.destination.boardId) {
              return { kind: 'scope_invalid' as const };
            }
            boardIds = [input.destination.boardId];
          } else if (input.destination.mode === 'create') {
            const context = this.ownerBoardCreateContext(
              input.ownerUserDatabaseId,
              input.ownerUserPublicId,
            );
            const created = await this.boardCreate.createInTransaction({
              connection,
              context,
              request: this.pairingBoardCreateRequest(input.pairingId, input.destination.title),
            });
            if (created.result.type !== 'board.create')
              throw new Error('pairing board create returned an invalid result');
            boardIds = [created.result.board.boardId];
          } else {
            boardIds = [];
          }

          const absoluteExpiresAt = mysqlTimestampToMillis(approvingSession.absoluteExpiresAt);
          const grantExpiresAt =
            input.lifetime === 'session'
              ? absoluteExpiresAt
              : input.now + 90 * 24 * 60 * 60 * 1_000;
          const redeemExpiresAt = Math.min(input.now + 2 * 60 * 1_000, grantExpiresAt);
          let grantDatabaseId: string;
          try {
            const [inserted] = await connection.execute<ResultSetHeader>(
              `
            INSERT INTO mcp_grants (
              public_id, owner_user_id, client_id, source_session_id,
              scope_mask, lifecycle_mask, lifetime, status,
              expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `,
              [
                input.grantPublicId,
                input.ownerUserDatabaseId,
                row.clientDatabaseId,
                input.lifetime === 'session' ? input.approvingSessionDatabaseId : null,
                input.approvedScopeMask,
                input.approvedLifecycleMask,
                input.lifetime === 'session' ? 1 : 2,
                new Date(grantExpiresAt),
                new Date(input.now),
                new Date(input.now),
              ],
            );
            grantDatabaseId = String(inserted.insertId);
          } catch (error) {
            if (isDuplicateKey(error))
              throw new PairingCollisionError('grant identifier collision');
            throw error;
          }
          for (const boardId of boardIds) {
            await connection.execute(
              'INSERT INTO mcp_grant_boards (grant_id, board_public_id, created_at) VALUES (?, ?, ?)',
              [grantDatabaseId, boardId, new Date(input.now)],
            );
          }
          const [approved] = await connection.execute<ResultSetHeader>(
            `
          UPDATE pairing_requests
          SET
            state = 3,
            source_session_id = ?,
            approved_scope_mask = ?,
            approved_lifecycle_mask = ?,
            lifetime = ?,
            decided_at = ?,
            redeem_expires_at = ?,
            grant_id = ?,
            updated_at = ?
          WHERE id = ? AND owner_user_id = ? AND state = 2 AND decision_expires_at > ?
        `,
            [
              input.approvingSessionDatabaseId,
              input.approvedScopeMask,
              input.approvedLifecycleMask,
              input.lifetime === 'session' ? 1 : 2,
              new Date(input.now),
              new Date(redeemExpiresAt),
              grantDatabaseId,
              new Date(input.now),
              row.id,
              input.ownerUserDatabaseId,
              new Date(input.now),
            ],
          );
          if (approved.affectedRows !== 1)
            throw new Error('pairing decision compare-and-set failed');
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'grant_issue',
              userPublicId: input.ownerUserPublicId,
              sessionPublicId: input.approvingSessionPublicId,
              clientPublicId: row.clientPublicId,
              grantPublicId: input.grantPublicId,
              pairingPublicId: row.publicId,
              subjectFingerprint: null,
              metadata: { lifetime: input.lifetime },
            },
          );
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'pairing_approve',
              userPublicId: input.ownerUserPublicId,
              sessionPublicId: input.approvingSessionPublicId,
              clientPublicId: row.clientPublicId,
              grantPublicId: input.grantPublicId,
              pairingPublicId: row.publicId,
              subjectFingerprint: null,
              metadata: { lifetime: input.lifetime },
            },
          );
          return {
            kind: 'decided' as const,
            status: this.decisionStatus(
              row,
              input,
              input.approvedScopeMask,
              input.approvedLifecycleMask,
              redeemExpiresAt,
              3,
              boardIds,
            ),
          };
        }),
      );
    } catch (error) {
      if (
        error instanceof PairingCollisionError ||
        error instanceof BoardCreateIdentifierCollisionError
      ) {
        return { kind: 'collision' };
      }
      return { kind: 'service_unavailable' };
    }
  }
}
