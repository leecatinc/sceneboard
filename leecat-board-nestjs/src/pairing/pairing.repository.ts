import { Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import type { PairingId } from '../common/ids/public-id.js';
import type { ClientId } from '../common/ids/public-id.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { BoardIdParserV1, type BoardId } from '@leecat-board/board-schema';
import { parseClientId, type GrantId } from '../common/ids/public-id.js';
import { parseGrantId } from '../common/ids/public-id.js';
import {
  buildPairingClientSummary,
  buildPairingOwnerStatus,
  type PairingOwnerStatus,
} from './pairing.status.js';
import {
  buildPairingClientStatus,
  type PairingClientStatus,
} from './pairing-client.status.js';
import { buildGrantSummary, type GrantSummary } from '../grants/grant.status.js';

export interface CreatePairingPersistenceInput {
  publicId: PairingId;
  ownerUserDatabaseId: string;
  sourceSessionDatabaseId: string;
  ownerUserPublicId: string;
  sourceSessionPublicId: string;
  locatorHash: Buffer;
  verifierHash: Buffer;
  now: number;
  codeExpiresAt: number;
}

export type CreatePairingPersistenceResult =
  | { kind: 'created' }
  | { kind: 'quota'; retryAfterSeconds: number }
  | { kind: 'collision' }
  | { kind: 'unavailable' };

export interface ClaimPairingPersistenceInput {
  clientPublicId: ClientId;
  locatorHash: Buffer;
  verifierHash: Buffer;
  installationId: string;
  clientName: string;
  clientProofChallenge: Buffer;
  requestedScopeMask: number;
  requestedLifecycleMask: number;
  now: number;
  decisionExpiresAt: number;
}

export type ClaimPairingPersistenceResult =
  | { kind: 'claimed'; pairingId: PairingId }
  | { kind: 'unavailable' }
  | { kind: 'collision' }
  | { kind: 'service_unavailable' };

export type DecidePairingPersistenceInput = {
  pairingId: PairingId;
  ownerUserDatabaseId: string;
  ownerUserPublicId: string;
  approvingSessionDatabaseId: string;
  approvingSessionPublicId: string;
  approvingFamilyPublicId: string;
  now: number;
} & (
  | { decision: 'deny' }
  | {
    decision: 'approve';
    grantPublicId: GrantId;
    approvedScopeMask: number;
    approvedLifecycleMask: number;
    boardIds: BoardId[];
    lifetime: 'session' | 'persistent';
  }
);

export type DecidePairingPersistenceResult =
  | { kind: 'decided'; status: PairingOwnerStatus }
  | { kind: 'not_found' | 'conflict' | 'scope_invalid' | 'collision' | 'service_unavailable' };

export interface ClientStatusPersistenceInput {
  pairingId: PairingId;
  proofChallenge: Buffer;
  now: number;
}

export type ClientStatusPersistenceResult =
  | { kind: 'status'; status: PairingClientStatus }
  | { kind: 'proof_invalid' | 'service_unavailable' };

export interface RedeemPairingPersistenceInput {
  pairingId: PairingId;
  proofChallenge: Buffer;
  credentialLocator: Buffer;
  credentialHash: Buffer;
  now: number;
}

export type RedeemPairingPersistenceResult =
  | { kind: 'redeemed'; grant: GrantSummary }
  | { kind: 'not_ready'; retryAfterSeconds: 2 | 5 | 10 }
  | { kind: 'proof_invalid' | 'terminal' | 'collision' | 'service_unavailable' };

export interface OwnerPairingPersistenceInput {
  pairingId: PairingId;
  ownerUserDatabaseId: string;
  ownerUserPublicId: string;
  sessionPublicId: string;
  now: number;
}

export type OwnerPairingPersistenceResult =
  | { kind: 'status'; status: PairingOwnerStatus }
  | { kind: 'not_found' | 'service_unavailable' };

export type CancelPairingPersistenceResult =
  | { kind: 'cancelled' }
  | { kind: 'not_found' | 'conflict' | 'service_unavailable' };

class PairingCollisionError extends Error {}

interface ClientPairingRow extends RowDataPacket {
  id: string;
  publicId: PairingId;
  ownerUserPublicId: string;
  sourceSessionPublicId: string;
  state: number;
  proofChallenge: Buffer | null;
  claimedAt: string | null;
  decisionExpiresAt: string | null;
  redeemExpiresAt: string | null;
  requestedScopeMask: number;
  requestedLifecycleMask: number;
  approvedScopeMask: number | null;
  approvedLifecycleMask: number | null;
  lifetime: number | null;
  grantDatabaseId: string | null;
  grantPublicId: string | null;
  grantStatus: number | null;
  grantExpiresAt: string | null;
  grantCreatedAt: string | null;
  grantActivatedAt: string | null;
  grantLastUsedAt: string | null;
  grantRevokedAt: string | null;
  clientPublicId: string | null;
  clientName: string | null;
  installationId: string | null;
  createdAt: string;
  codeExpiresAt: string;
  decidedAt: string | null;
}

interface DuePairingRow extends RowDataPacket {
  id: string;
  publicId: string;
  grantId: string | null;
}

@Injectable()
export class PairingRepository {
  constructor(
    @Inject(MysqlService) private readonly mysql: MysqlService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async create(input: CreatePairingPersistenceInput): Promise<CreatePairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const [users] = await connection.execute<Array<RowDataPacket & { status: number }>>(
          'SELECT status FROM users WHERE id = ? FOR UPDATE',
          [input.ownerUserDatabaseId],
        );
        if (users[0]?.status !== 1) return { kind: 'unavailable' as const };
        const [sessions] = await connection.execute<Array<RowDataPacket & {
          status: number;
          idleExpiresAt: string;
          absoluteExpiresAt: string;
        }>>(`
          SELECT status, idle_expires_at AS idleExpiresAt, absolute_expires_at AS absoluteExpiresAt
          FROM auth_sessions
          WHERE id = ? AND user_id = ?
          FOR UPDATE
        `, [input.sourceSessionDatabaseId, input.ownerUserDatabaseId]);
        const session = sessions[0];
        if (
          session?.status !== 1
          || mysqlTimestampToMillis(session.idleExpiresAt) <= input.now
          || mysqlTimestampToMillis(session.absoluteExpiresAt) <= input.now
        ) return { kind: 'unavailable' as const };

        await this.expireDuePairings(connection, input.ownerUserDatabaseId, input.ownerUserPublicId, input.now);
        const [quotaRows] = await connection.execute<Array<RowDataPacket & {
          activeCount: string;
          earliestDeadline: string | null;
        }>>(`
          SELECT
            CAST(COUNT(*) AS CHAR) AS activeCount,
            MIN(CASE
              WHEN state = 1 THEN code_expires_at
              WHEN state = 2 THEN decision_expires_at
              ELSE redeem_expires_at
            END) AS earliestDeadline
          FROM pairing_requests
          WHERE owner_user_id = ? AND state IN (1, 2, 3)
        `, [input.ownerUserDatabaseId]);
        const quota = quotaRows[0];
        if (Number(quota?.activeCount ?? 0) >= 5) {
          const retryAt = quota?.earliestDeadline === null || quota?.earliestDeadline === undefined
            ? input.now + 1_000
            : mysqlTimestampToMillis(quota.earliestDeadline);
          return { kind: 'quota' as const, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - input.now) / 1_000)) };
        }

        try {
          await connection.execute(`
            INSERT INTO pairing_requests (
              public_id, owner_user_id, source_session_id,
              code_locator_hash, code_verifier_hash, state,
              matched_failure_count, code_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
          `, [
            input.publicId,
            input.ownerUserDatabaseId,
            input.sourceSessionDatabaseId,
            input.locatorHash,
            input.verifierHash,
            new Date(input.codeExpiresAt),
            new Date(input.now),
            new Date(input.now),
          ]);
        } catch (error) {
          if (isDuplicateKey(error)) throw new PairingCollisionError('pairing identifier collision');
          throw error;
        }
        await this.audit.writeMandatory({ connection }, {
          event: 'pairing_create',
          userPublicId: input.ownerUserPublicId,
          sessionPublicId: input.sourceSessionPublicId,
          subjectFingerprint: null,
          pairingPublicId: input.publicId,
          metadata: { state: 'created' },
        });
        return { kind: 'created' as const };
      }));
    } catch (error) {
      if (error instanceof PairingCollisionError) return { kind: 'collision' };
      return { kind: 'unavailable' };
    }
  }

  async claim(input: ClaimPairingPersistenceInput): Promise<ClaimPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const [rows] = await connection.execute<Array<RowDataPacket & {
          id: string;
          publicId: PairingId;
          ownerUserDatabaseId: string;
          ownerUserPublicId: string;
          sourceSessionPublicId: string;
          verifierHash: Buffer;
          state: number;
          matchedFailureCount: number;
          codeExpiresAt: string;
        }>>(`
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
        `, [input.locatorHash]);
        const row = rows[0];
        if (!row || row.state !== 1 || row.matchedFailureCount >= 5) return { kind: 'unavailable' as const };
        if (mysqlTimestampToMillis(row.codeExpiresAt) <= input.now) {
          const [expired] = await connection.execute<ResultSetHeader>(`
            UPDATE pairing_requests
            SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
            WHERE id = ? AND state = 1 AND code_expires_at <= ?
          `, [new Date(input.now), row.id, new Date(input.now)]);
          if (expired.affectedRows !== 1) throw new Error('pairing expiry compare-and-set failed');
          await this.audit.writeMandatory({ connection }, {
            event: 'pairing_expire',
            userPublicId: row.ownerUserPublicId,
            sessionPublicId: row.sourceSessionPublicId,
            subjectFingerprint: null,
            pairingPublicId: row.publicId,
            metadata: { reason: 'code_deadline' },
          });
          return { kind: 'unavailable' as const };
        }
        if (!this.crypto.constantTimeEqual(input.verifierHash, row.verifierHash)) {
          const nextFailureCount = row.matchedFailureCount + 1;
          const [failed] = await connection.execute<ResultSetHeader>(`
            UPDATE pairing_requests
            SET
              matched_failure_count = ?,
              state = ?,
              code_locator_hash = IF(? = 8, NULL, code_locator_hash),
              code_verifier_hash = IF(? = 8, NULL, code_verifier_hash),
              updated_at = ?
            WHERE id = ? AND state = 1 AND code_expires_at > ? AND matched_failure_count = ?
          `, [
            nextFailureCount,
            nextFailureCount === 5 ? 8 : 1,
            nextFailureCount === 5 ? 8 : 1,
            nextFailureCount === 5 ? 8 : 1,
            new Date(input.now),
            row.id,
            new Date(input.now),
            row.matchedFailureCount,
          ]);
          if (failed.affectedRows !== 1) throw new Error('pairing failure compare-and-set failed');
          if (nextFailureCount === 5) {
            await this.audit.writeMandatory({ connection }, {
              event: 'pairing_lock',
              userPublicId: row.ownerUserPublicId,
              sessionPublicId: row.sourceSessionPublicId,
              subjectFingerprint: null,
              pairingPublicId: row.publicId,
              metadata: { reason: 'attempt_limit' },
            });
          }
          return { kind: 'unavailable' as const };
        }

        const clientId = await this.upsertClient(connection, row.ownerUserDatabaseId, input);
        const [claimed] = await connection.execute<ResultSetHeader>(`
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
        `, [
          clientId,
          input.clientProofChallenge,
          input.requestedScopeMask,
          input.requestedLifecycleMask,
          new Date(input.now),
          new Date(input.decisionExpiresAt),
          new Date(input.now),
          row.id,
          new Date(input.now),
        ]);
        if (claimed.affectedRows !== 1) throw new Error('pairing claim compare-and-set failed');
        await this.audit.writeMandatory({ connection }, {
          event: 'pairing_claim',
          userPublicId: row.ownerUserPublicId,
          sessionPublicId: row.sourceSessionPublicId,
          subjectFingerprint: null,
          clientPublicId: input.clientPublicId,
          pairingPublicId: row.publicId,
          metadata: { state: 'pending' },
        });
        return { kind: 'claimed' as const, pairingId: row.publicId };
      }));
    } catch (error) {
      if (error instanceof PairingCollisionError) return { kind: 'collision' };
      return { kind: 'service_unavailable' };
    }
  }

  async decide(input: DecidePairingPersistenceInput): Promise<DecidePairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const [users] = await connection.execute<Array<RowDataPacket & { status: number }>>(
          'SELECT status FROM users WHERE id = ? FOR UPDATE',
          [input.ownerUserDatabaseId],
        );
        if (users[0]?.status !== 1) return { kind: 'service_unavailable' as const };
        const [familyRows] = await connection.execute<Array<RowDataPacket & {
          id: string;
          status: number;
          idleExpiresAt: string;
          absoluteExpiresAt: string;
        }>>(`
          SELECT
            CAST(id AS CHAR) AS id,
            status,
            idle_expires_at AS idleExpiresAt,
            absolute_expires_at AS absoluteExpiresAt
          FROM auth_sessions
          WHERE family_public_id = ?
          ORDER BY id
          FOR UPDATE
        `, [input.approvingFamilyPublicId]);
        const approvingSession = familyRows.find((row) => row.id === input.approvingSessionDatabaseId);
        if (
          approvingSession?.status !== 1
          || mysqlTimestampToMillis(approvingSession.idleExpiresAt) <= input.now
          || mysqlTimestampToMillis(approvingSession.absoluteExpiresAt) <= input.now
        ) return { kind: 'service_unavailable' as const };

        const [rows] = await connection.execute<Array<RowDataPacket & {
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
        }>>(`
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
        `, [input.pairingId, input.ownerUserDatabaseId]);
        const row = rows[0];
        if (!row) return { kind: 'not_found' as const };
        if (row.state !== 2) return { kind: 'conflict' as const };
        if (mysqlTimestampToMillis(row.decisionExpiresAt) <= input.now) {
          await this.expirePendingDecision(connection, row, input);
          return { kind: 'conflict' as const };
        }

        if (input.decision === 'deny') {
          const [denied] = await connection.execute<ResultSetHeader>(`
            UPDATE pairing_requests
            SET state = 5, decided_at = ?, updated_at = ?
            WHERE id = ? AND owner_user_id = ? AND state = 2 AND decision_expires_at > ?
          `, [new Date(input.now), new Date(input.now), row.id, input.ownerUserDatabaseId, new Date(input.now)]);
          if (denied.affectedRows !== 1) return { kind: 'conflict' as const };
          await this.audit.writeMandatory({ connection }, {
            event: 'pairing_deny',
            userPublicId: input.ownerUserPublicId,
            sessionPublicId: input.approvingSessionPublicId,
            pairingPublicId: row.publicId,
            clientPublicId: row.clientPublicId,
            subjectFingerprint: null,
            metadata: { reason: 'owner' },
          });
          return {
            kind: 'decided' as const,
            status: this.decisionStatus(row, input, null, null, null, 5),
          };
        }

        if (
          (input.approvedScopeMask & row.requestedScopeMask) !== input.approvedScopeMask
          || (input.approvedLifecycleMask & row.requestedLifecycleMask) !== input.approvedLifecycleMask
        ) return { kind: 'scope_invalid' as const };
        const [boardRows] = await connection.execute<Array<RowDataPacket & { publicId: BoardId }>>(`
          SELECT public_id AS publicId
          FROM boards
          WHERE owner_user_id = ? AND public_id IN (${input.boardIds.map(() => '?').join(', ')})
          ORDER BY public_id
          FOR UPDATE
        `, [input.ownerUserDatabaseId, ...input.boardIds]);
        if (
          boardRows.length !== input.boardIds.length
          || boardRows.some((board, index) => board.publicId !== input.boardIds[index])
        ) return { kind: 'scope_invalid' as const };

        const absoluteExpiresAt = mysqlTimestampToMillis(approvingSession.absoluteExpiresAt);
        const grantExpiresAt = input.lifetime === 'session'
          ? absoluteExpiresAt
          : input.now + 90 * 24 * 60 * 60 * 1_000;
        const redeemExpiresAt = Math.min(input.now + 2 * 60 * 1_000, grantExpiresAt);
        let grantDatabaseId: string;
        try {
          const [inserted] = await connection.execute<ResultSetHeader>(`
            INSERT INTO mcp_grants (
              public_id, owner_user_id, client_id, source_session_id,
              scope_mask, lifecycle_mask, lifetime, status,
              expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `, [
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
          ]);
          grantDatabaseId = String(inserted.insertId);
        } catch (error) {
          if (isDuplicateKey(error)) throw new PairingCollisionError('grant identifier collision');
          throw error;
        }
        for (const boardId of input.boardIds) {
          await connection.execute(
            'INSERT INTO mcp_grant_boards (grant_id, board_public_id, created_at) VALUES (?, ?, ?)',
            [grantDatabaseId, boardId, new Date(input.now)],
          );
        }
        const [approved] = await connection.execute<ResultSetHeader>(`
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
        `, [
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
        ]);
        if (approved.affectedRows !== 1) throw new Error('pairing decision compare-and-set failed');
        await this.audit.writeMandatory({ connection }, {
          event: 'grant_issue',
          userPublicId: input.ownerUserPublicId,
          sessionPublicId: input.approvingSessionPublicId,
          clientPublicId: row.clientPublicId,
          grantPublicId: input.grantPublicId,
          pairingPublicId: row.publicId,
          subjectFingerprint: null,
          metadata: { lifetime: input.lifetime },
        });
        await this.audit.writeMandatory({ connection }, {
          event: 'pairing_approve',
          userPublicId: input.ownerUserPublicId,
          sessionPublicId: input.approvingSessionPublicId,
          clientPublicId: row.clientPublicId,
          grantPublicId: input.grantPublicId,
          pairingPublicId: row.publicId,
          subjectFingerprint: null,
          metadata: { lifetime: input.lifetime },
        });
        return {
          kind: 'decided' as const,
          status: this.decisionStatus(
            row,
            input,
            input.approvedScopeMask,
            input.approvedLifecycleMask,
            redeemExpiresAt,
            3,
          ),
        };
      }));
    } catch (error) {
      if (error instanceof PairingCollisionError) return { kind: 'collision' };
      return { kind: 'service_unavailable' };
    }
  }

  async clientStatus(input: ClientStatusPersistenceInput): Promise<ClientStatusPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const familyRows = await this.lockPairingFamily(connection, input.pairingId);
        const row = await this.lockClientPairing(connection, input.pairingId);
        if (!this.hasValidProof(row, input.proofChallenge)) return { kind: 'proof_invalid' as const };

        if (row.state === 2 && this.timestampRequired(row.decisionExpiresAt) <= input.now) {
          await this.expireClaimedPairing(connection, row, input.now, 'decision_deadline');
          row.state = 7;
        } else if (row.state === 3) {
          await this.lockGrantForPairing(connection, row);
          const familyLive = this.hasLiveFamilySession(familyRows, input.now);
          const deadlineReached = this.timestampRequired(row.redeemExpiresAt) <= input.now
            || this.timestampRequired(row.grantExpiresAt) <= input.now;
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
      }));
    } catch {
      return { kind: 'service_unavailable' };
    }
  }

  async redeem(input: RedeemPairingPersistenceInput): Promise<RedeemPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const familyRows = await this.lockPairingFamily(connection, input.pairingId);
        const row = await this.lockClientPairing(connection, input.pairingId);
        if (!this.hasValidProof(row, input.proofChallenge)) return { kind: 'proof_invalid' as const };

        if (row.state === 2) {
          if (this.timestampRequired(row.decisionExpiresAt) <= input.now) {
            await this.expireClaimedPairing(connection, row, input.now, 'decision_deadline');
            return { kind: 'terminal' as const };
          }
          return {
            kind: 'not_ready' as const,
            retryAfterSeconds: this.clientStatusFromRow(row, input.now).retryAfterSeconds as 2 | 5 | 10,
          };
        }
        if (row.state !== 3) return { kind: 'terminal' as const };

        await this.lockGrantForPairing(connection, row);
        const familyLive = this.hasLiveFamilySession(familyRows, input.now);
        const deadlineReached = this.timestampRequired(row.redeemExpiresAt) <= input.now
          || this.timestampRequired(row.grantExpiresAt) <= input.now;
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
          await connection.execute(`
            INSERT INTO mcp_grant_credentials (
              grant_id, locator, token_hash, status, created_at
            ) VALUES (?, ?, ?, 1, ?)
          `, [row.grantDatabaseId, input.credentialLocator, input.credentialHash, new Date(input.now)]);
        } catch (error) {
          if (isDuplicateKey(error)) throw new PairingCollisionError('grant credential locator collision');
          throw error;
        }
        const [activated] = await connection.execute<ResultSetHeader>(`
          UPDATE mcp_grants
          SET status = 2, activated_at = ?, updated_at = ?
          WHERE id = ? AND status = 1 AND expires_at > ?
        `, [new Date(input.now), new Date(input.now), row.grantDatabaseId, new Date(input.now)]);
        if (activated.affectedRows !== 1) throw new Error('grant activation compare-and-set failed');
        const [redeemed] = await connection.execute<ResultSetHeader>(`
          UPDATE pairing_requests
          SET state = 4, updated_at = ?
          WHERE id = ? AND state = 3 AND redeem_expires_at > ?
        `, [new Date(input.now), row.id, new Date(input.now)]);
        if (redeemed.affectedRows !== 1) throw new Error('pairing redemption compare-and-set failed');

        const lifetime = row.lifetime === 1 ? 'session' : row.lifetime === 2 ? 'persistent' : null;
        if (lifetime === null) throw new Error('approved pairing has invalid lifetime');
        await this.audit.writeMandatory({ connection }, {
          event: 'pairing_redeem',
          userPublicId: row.ownerUserPublicId,
          sessionPublicId: row.sourceSessionPublicId,
          clientPublicId: row.clientPublicId,
          grantPublicId: row.grantPublicId,
          pairingPublicId: row.publicId,
          subjectFingerprint: null,
          metadata: { lifetime },
        });
        return {
          kind: 'redeemed' as const,
          grant: this.redeemedGrantFromRow(row, boardIds, input.now),
        };
      }));
    } catch (error) {
      if (error instanceof PairingCollisionError) return { kind: 'collision' };
      return { kind: 'service_unavailable' };
    }
  }

  async ownerStatus(input: OwnerPairingPersistenceInput): Promise<OwnerPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const familyRows = await this.lockPairingFamily(
          connection,
          input.pairingId,
          input.ownerUserDatabaseId,
        );
        const row = await this.lockClientPairing(connection, input.pairingId, input.ownerUserDatabaseId);
        if (row === undefined) return { kind: 'not_found' as const };
        await this.applyOwnerLazyExpiry(connection, row, familyRows, input);
        const boardIds = row.approvedScopeMask === null || row.grantDatabaseId === null
          ? null
          : await this.readGrantBoardIds(connection, row.grantDatabaseId);
        return { kind: 'status' as const, status: this.ownerStatusFromRow(row, boardIds) };
      }));
    } catch {
      return { kind: 'service_unavailable' };
    }
  }

  async listActive(input: Omit<OwnerPairingPersistenceInput, 'pairingId'>): Promise<PairingOwnerStatus[]> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const [links] = await connection.execute<Array<RowDataPacket & {
          pairingId: PairingId;
          familyPublicId: string;
        }>>(`
          SELECT p.public_id AS pairingId, s.family_public_id AS familyPublicId
          FROM pairing_requests p
          JOIN auth_sessions s ON s.id = p.source_session_id
          WHERE p.owner_user_id = ? AND p.state IN (1, 2, 3)
          ORDER BY p.id
          LIMIT 6
        `, [input.ownerUserDatabaseId]);
        if (links.length > 5) throw new Error('owner active pairing invariant exceeded');
        const familyIds = [...new Set(links.map((link) => link.familyPublicId))].sort();
        const familyRowsById = new Map<string, Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>>();
        if (familyIds.length > 0) {
          const placeholders = familyIds.map(() => '?').join(', ');
          const [familyRows] = await connection.execute<Array<RowDataPacket & {
            familyPublicId: string;
            status: number;
            idleExpiresAt: string;
            absoluteExpiresAt: string;
          }>>(`
            SELECT
              family_public_id AS familyPublicId,
              status,
              idle_expires_at AS idleExpiresAt,
              absolute_expires_at AS absoluteExpiresAt
            FROM auth_sessions
            WHERE family_public_id IN (${placeholders})
            ORDER BY family_public_id, id
            FOR UPDATE
          `, familyIds);
          for (const family of familyRows) {
            const group = familyRowsById.get(family.familyPublicId) ?? [];
            group.push(family);
            familyRowsById.set(family.familyPublicId, group);
          }
        }

        const statuses: PairingOwnerStatus[] = [];
        for (const link of links) {
          const row = await this.lockClientPairing(connection, link.pairingId, input.ownerUserDatabaseId);
          if (row === undefined || ![1, 2, 3].includes(row.state)) continue;
          await this.applyOwnerLazyExpiry(
            connection,
            row,
            familyRowsById.get(link.familyPublicId) ?? [],
            input,
          );
          if (![1, 2, 3].includes(row.state)) continue;
          const boardIds = row.approvedScopeMask === null || row.grantDatabaseId === null
            ? null
            : await this.readGrantBoardIds(connection, row.grantDatabaseId);
          statuses.push(this.ownerStatusFromRow(row, boardIds));
        }
        return statuses.sort((left, right) => (
          right.createdAt.localeCompare(left.createdAt) || right.pairingId.localeCompare(left.pairingId)
        ));
      }));
    } catch {
      throw new Error('pairing list is unavailable');
    }
  }

  async cancel(input: OwnerPairingPersistenceInput): Promise<CancelPairingPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) => withTransaction(connection, 'READ COMMITTED', async () => {
        const familyRows = await this.lockPairingFamily(
          connection,
          input.pairingId,
          input.ownerUserDatabaseId,
        );
        const row = await this.lockClientPairing(connection, input.pairingId, input.ownerUserDatabaseId);
        if (row === undefined) return { kind: 'not_found' as const };
        await this.applyOwnerLazyExpiry(connection, row, familyRows, input);
        if (row.state === 6) {
          await this.audit.writeMandatory({ connection }, {
            event: 'pairing_cancel',
            userPublicId: input.ownerUserPublicId,
            sessionPublicId: input.sessionPublicId,
            clientPublicId: row.clientPublicId,
            grantPublicId: row.grantPublicId,
            pairingPublicId: row.publicId,
            subjectFingerprint: null,
            metadata: { reason: 'already_cancelled' },
          });
          return { kind: 'cancelled' as const };
        }
        if (![1, 2, 3].includes(row.state)) return { kind: 'conflict' as const };

        if (row.state === 3) {
          if (row.grantDatabaseId === null || row.grantPublicId === null || row.grantStatus !== 1) {
            throw new Error('approved pairing has no cancellable pending grant');
          }
          await connection.execute(
            'SELECT id FROM mcp_grant_credentials WHERE grant_id = ? ORDER BY id FOR UPDATE',
            [row.grantDatabaseId],
          );
          await connection.execute(`
            UPDATE mcp_grant_credentials SET status = 3, revoked_at = ?
            WHERE grant_id = ? AND status = 1
          `, [new Date(input.now), row.grantDatabaseId]);
          const [revoked] = await connection.execute<ResultSetHeader>(`
            UPDATE mcp_grants
            SET status = 3, revoked_at = ?, revoke_reason = 1, updated_at = ?
            WHERE id = ? AND status = 1
          `, [new Date(input.now), new Date(input.now), row.grantDatabaseId]);
          if (revoked.affectedRows !== 1) throw new Error('pending grant cancellation compare-and-set failed');
          await this.audit.writeMandatory({ connection }, {
            event: 'grant_revoke',
            userPublicId: input.ownerUserPublicId,
            sessionPublicId: input.sessionPublicId,
            clientPublicId: row.clientPublicId,
            grantPublicId: row.grantPublicId,
            pairingPublicId: row.publicId,
            subjectFingerprint: null,
            metadata: { reason: 'owner' },
          });
        }
        const [cancelled] = await connection.execute<ResultSetHeader>(`
          UPDATE pairing_requests
          SET state = 6, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
          WHERE id = ? AND owner_user_id = ? AND state IN (1, 2, 3)
        `, [new Date(input.now), row.id, input.ownerUserDatabaseId]);
        if (cancelled.affectedRows !== 1) throw new Error('pairing cancellation compare-and-set failed');
        await this.audit.writeMandatory({ connection }, {
          event: 'pairing_cancel',
          userPublicId: input.ownerUserPublicId,
          sessionPublicId: input.sessionPublicId,
          clientPublicId: row.clientPublicId,
          grantPublicId: row.grantPublicId,
          pairingPublicId: row.publicId,
          subjectFingerprint: null,
          metadata: { reason: 'owner' },
        });
        return { kind: 'cancelled' as const };
      }));
    } catch {
      return { kind: 'service_unavailable' };
    }
  }

  private async applyOwnerLazyExpiry(
    connection: PoolConnection,
    row: ClientPairingRow,
    familyRows: Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>,
    input: Omit<OwnerPairingPersistenceInput, 'pairingId'>,
  ): Promise<void> {
    if (row.state === 1 && mysqlTimestampToMillis(row.codeExpiresAt) <= input.now) {
      const [expired] = await connection.execute<ResultSetHeader>(`
        UPDATE pairing_requests
        SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
        WHERE id = ? AND state = 1 AND code_expires_at <= ?
      `, [new Date(input.now), row.id, new Date(input.now)]);
      if (expired.affectedRows !== 1) throw new Error('created pairing expiry compare-and-set failed');
      await this.audit.writeMandatory({ connection }, {
        event: 'pairing_expire',
        userPublicId: input.ownerUserPublicId,
        sessionPublicId: input.sessionPublicId,
        pairingPublicId: row.publicId,
        subjectFingerprint: null,
        metadata: { reason: 'code_deadline' },
      });
      row.state = 7;
      return;
    }
    if (row.state === 2 && this.timestampRequired(row.decisionExpiresAt) <= input.now) {
      await this.expireClaimedPairing(connection, row, input.now, 'decision_deadline');
      row.state = 7;
      return;
    }
    if (row.state === 3) {
      await this.lockGrantForPairing(connection, row);
      const familyLive = this.hasLiveFamilySession(familyRows, input.now);
      const deadlineReached = this.timestampRequired(row.redeemExpiresAt) <= input.now
        || this.timestampRequired(row.grantExpiresAt) <= input.now;
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
  }

  private ownerStatusFromRow(row: ClientPairingRow, boardIds: BoardId[] | null): PairingOwnerStatus {
    const client = row.clientPublicId === null || row.clientName === null || row.installationId === null
      ? null
      : {
        clientId: parseClientId(row.clientPublicId),
        clientName: row.clientName,
        installationId: row.installationId,
      };
    return buildPairingOwnerStatus({
      pairingId: row.publicId,
      state: row.state,
      createdAt: mysqlTimestampToMillis(row.createdAt),
      codeExpiresAt: mysqlTimestampToMillis(row.codeExpiresAt),
      decisionExpiresAt: timestampOrNull(row.decisionExpiresAt),
      redeemExpiresAt: timestampOrNull(row.redeemExpiresAt),
      client,
      requestedScopeMask: row.requestedScopeMask,
      requestedLifecycleMask: row.requestedLifecycleMask,
      approvedScopeMask: row.approvedScopeMask,
      approvedLifecycleMask: row.approvedLifecycleMask,
      boardIds,
      lifetime: row.lifetime,
      decidedAt: timestampOrNull(row.decidedAt),
    }, this.crypto);
  }

  private async lockPairingFamily(
    connection: PoolConnection,
    pairingId: PairingId,
    ownerUserDatabaseId?: string,
  ): Promise<Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>> {
    const [links] = await connection.execute<Array<RowDataPacket & { familyPublicId: string }>>(`
      SELECT s.family_public_id AS familyPublicId
      FROM pairing_requests p
      JOIN auth_sessions s ON s.id = p.source_session_id
      WHERE p.public_id = ?${ownerUserDatabaseId === undefined ? '' : ' AND p.owner_user_id = ?'}
      LIMIT 1
    `, ownerUserDatabaseId === undefined ? [pairingId] : [pairingId, ownerUserDatabaseId]);
    const familyPublicId = links[0]?.familyPublicId;
    if (familyPublicId === undefined) return [];
    const [rows] = await connection.execute<Array<RowDataPacket & {
      status: number;
      idleExpiresAt: string;
      absoluteExpiresAt: string;
    }>>(`
      SELECT status, idle_expires_at AS idleExpiresAt, absolute_expires_at AS absoluteExpiresAt
      FROM auth_sessions
      WHERE family_public_id = ?
      ORDER BY id
      FOR UPDATE
    `, [familyPublicId]);
    return rows;
  }

  private async lockClientPairing(
    connection: PoolConnection,
    pairingId: PairingId,
    ownerUserDatabaseId?: string,
  ): Promise<ClientPairingRow | undefined> {
    const [rows] = await connection.execute<ClientPairingRow[]>(`
      SELECT
        CAST(p.id AS CHAR) AS id,
        p.public_id AS publicId,
        u.public_id AS ownerUserPublicId,
        s.public_id AS sourceSessionPublicId,
        p.state,
        p.client_proof_challenge AS proofChallenge,
        p.claimed_at AS claimedAt,
        p.decision_expires_at AS decisionExpiresAt,
        p.redeem_expires_at AS redeemExpiresAt,
        p.requested_scope_mask AS requestedScopeMask,
        p.requested_lifecycle_mask AS requestedLifecycleMask,
        p.approved_scope_mask AS approvedScopeMask,
        p.approved_lifecycle_mask AS approvedLifecycleMask,
        p.lifetime,
        p.created_at AS createdAt,
        p.code_expires_at AS codeExpiresAt,
        p.decided_at AS decidedAt,
        CAST(p.grant_id AS CHAR) AS grantDatabaseId,
        NULL AS grantPublicId,
        NULL AS grantStatus,
        NULL AS grantExpiresAt,
        NULL AS grantCreatedAt,
        NULL AS grantActivatedAt,
        NULL AS grantLastUsedAt,
        NULL AS grantRevokedAt,
        c.public_id AS clientPublicId,
        c.display_name AS clientName,
        c.installation_id AS installationId
      FROM pairing_requests p
      JOIN users u ON u.id = p.owner_user_id
      JOIN auth_sessions s ON s.id = p.source_session_id
      LEFT JOIN mcp_clients c ON c.id = p.client_id
      WHERE p.public_id = ?${ownerUserDatabaseId === undefined ? '' : ' AND p.owner_user_id = ?'}
      LIMIT 1
      FOR UPDATE
    `, ownerUserDatabaseId === undefined ? [pairingId] : [pairingId, ownerUserDatabaseId]);
    return rows[0];
  }

  private async lockGrantForPairing(connection: PoolConnection, row: ClientPairingRow): Promise<void> {
    if (row.grantDatabaseId === null) throw new Error('approved pairing has no grant');
    const [grants] = await connection.execute<Array<RowDataPacket & {
      publicId: string;
      status: number;
      expiresAt: string;
      createdAt: string;
      activatedAt: string | null;
      lastUsedAt: string | null;
      revokedAt: string | null;
    }>>(`
      SELECT
        public_id AS publicId,
        status,
        expires_at AS expiresAt,
        created_at AS createdAt,
        activated_at AS activatedAt,
        last_used_at AS lastUsedAt,
        revoked_at AS revokedAt
      FROM mcp_grants
      WHERE id = ?
      FOR UPDATE
    `, [row.grantDatabaseId]);
    const grant = grants[0];
    if (grant === undefined) throw new Error('approved pairing grant is missing');
    row.grantPublicId = grant.publicId;
    row.grantStatus = grant.status;
    row.grantExpiresAt = grant.expiresAt;
    row.grantCreatedAt = grant.createdAt;
    row.grantActivatedAt = grant.activatedAt;
    row.grantLastUsedAt = grant.lastUsedAt;
    row.grantRevokedAt = grant.revokedAt;
  }

  private hasValidProof(row: ClientPairingRow | undefined, proofChallenge: Buffer): row is ClientPairingRow {
    return row !== undefined
      && row.proofChallenge !== null
      && this.crypto.constantTimeEqual(row.proofChallenge, proofChallenge);
  }

  private hasLiveFamilySession(
    rows: Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>,
    now: number,
  ): boolean {
    return rows.some((row) => row.status === 1
      && mysqlTimestampToMillis(row.idleExpiresAt) > now
      && mysqlTimestampToMillis(row.absoluteExpiresAt) > now);
  }

  private clientStatusFromRow(row: ClientPairingRow, now: number): PairingClientStatus {
    return buildPairingClientStatus({
      pairingId: row.publicId,
      state: row.state,
      claimedAt: this.timestampRequired(row.claimedAt),
      decisionExpiresAt: timestampOrNull(row.decisionExpiresAt),
      redeemExpiresAt: timestampOrNull(row.redeemExpiresAt),
    }, now);
  }

  private async expireClaimedPairing(
    connection: PoolConnection,
    row: ClientPairingRow,
    now: number,
    reason: 'decision_deadline',
  ): Promise<void> {
    const [expired] = await connection.execute<ResultSetHeader>(`
      UPDATE pairing_requests SET state = 7, updated_at = ?
      WHERE id = ? AND state = 2 AND decision_expires_at <= ?
    `, [new Date(now), row.id, new Date(now)]);
    if (expired.affectedRows !== 1) throw new Error('pairing status expiry compare-and-set failed');
    await this.audit.writeMandatory({ connection }, {
      event: 'pairing_expire',
      userPublicId: row.ownerUserPublicId,
      sessionPublicId: row.sourceSessionPublicId,
      clientPublicId: row.clientPublicId,
      pairingPublicId: row.publicId,
      subjectFingerprint: null,
      metadata: { reason },
    });
  }

  private async expireApprovedPairing(
    connection: PoolConnection,
    row: ClientPairingRow,
    now: number,
    reason: 'deadline' | 'session_ended',
  ): Promise<void> {
    if (row.grantDatabaseId === null) throw new Error('approved pairing has no grant');
    await connection.execute(
      'SELECT id FROM mcp_grant_credentials WHERE grant_id = ? ORDER BY id FOR UPDATE',
      [row.grantDatabaseId],
    );
    await connection.execute(`
      UPDATE mcp_grant_credentials
      SET status = 3, revoked_at = ?
      WHERE grant_id = ? AND status = 1
    `, [new Date(now), row.grantDatabaseId]);
    const [grantResult] = await connection.execute<ResultSetHeader>(`
      UPDATE mcp_grants
      SET status = 4, revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE id = ? AND status = 1
    `, [new Date(now), reason === 'session_ended' ? 2 : 3, new Date(now), row.grantDatabaseId]);
    if (grantResult.affectedRows !== 1) throw new Error('pending grant expiry compare-and-set failed');
    const [pairingResult] = await connection.execute<ResultSetHeader>(`
      UPDATE pairing_requests SET state = 7, updated_at = ?
      WHERE id = ? AND state = 3
    `, [new Date(now), row.id]);
    if (pairingResult.affectedRows !== 1) throw new Error('approved pairing expiry compare-and-set failed');
    await this.audit.writeMandatory({ connection }, {
      event: 'grant_expire',
      userPublicId: row.ownerUserPublicId,
      sessionPublicId: row.sourceSessionPublicId,
      clientPublicId: row.clientPublicId,
      grantPublicId: row.grantPublicId,
      pairingPublicId: row.publicId,
      subjectFingerprint: null,
      metadata: { reason },
    });
    await this.audit.writeMandatory({ connection }, {
      event: 'pairing_expire',
      userPublicId: row.ownerUserPublicId,
      sessionPublicId: row.sourceSessionPublicId,
      clientPublicId: row.clientPublicId,
      grantPublicId: row.grantPublicId,
      pairingPublicId: row.publicId,
      subjectFingerprint: null,
      metadata: { reason },
    });
  }

  private async readGrantBoardIds(connection: PoolConnection, grantDatabaseId: string): Promise<BoardId[]> {
    const [rows] = await connection.execute<Array<RowDataPacket & { boardPublicId: string }>>(`
      SELECT board_public_id AS boardPublicId
      FROM mcp_grant_boards
      WHERE grant_id = ?
      ORDER BY board_public_id
    `, [grantDatabaseId]);
    return rows.map((row) => {
      const parsed = BoardIdParserV1.parse(row.boardPublicId);
      if (!parsed.ok) throw new Error('database returned an invalid board public ID');
      return parsed.data.value;
    });
  }

  private redeemedGrantFromRow(row: ClientPairingRow, boardIds: BoardId[], now: number): GrantSummary {
    if (
      row.grantPublicId === null
      || row.clientPublicId === null
      || row.clientName === null
      || row.installationId === null
      || row.approvedScopeMask === null
      || row.approvedLifecycleMask === null
      || row.lifetime === null
      || row.grantCreatedAt === null
      || row.grantExpiresAt === null
    ) throw new Error('approved pairing has incomplete grant data');
    return buildGrantSummary({
      grantId: parseGrantId(row.grantPublicId),
      client: buildPairingClientSummary({
        clientId: parseClientId(row.clientPublicId),
        clientName: row.clientName,
        installationId: row.installationId,
      }, this.crypto),
      scopeMask: row.approvedScopeMask,
      lifecycleMask: row.approvedLifecycleMask,
      boardIds,
      lifetime: row.lifetime,
      status: 2,
      createdAt: mysqlTimestampToMillis(row.grantCreatedAt),
      activatedAt: now,
      lastUsedAt: timestampOrNull(row.grantLastUsedAt),
      expiresAt: mysqlTimestampToMillis(row.grantExpiresAt),
      revokedAt: timestampOrNull(row.grantRevokedAt),
    });
  }

  private timestampRequired(value: string | null): number {
    if (value === null) throw new Error('database returned a missing timestamp');
    return mysqlTimestampToMillis(value);
  }

  private async expirePendingDecision(
    connection: PoolConnection,
    row: { id: string; publicId: PairingId; clientPublicId: string },
    input: DecidePairingPersistenceInput,
  ): Promise<void> {
    const [expired] = await connection.execute<ResultSetHeader>(`
      UPDATE pairing_requests
      SET state = 7, updated_at = ?
      WHERE id = ? AND state = 2 AND decision_expires_at <= ?
    `, [new Date(input.now), row.id, new Date(input.now)]);
    if (expired.affectedRows !== 1) throw new Error('pairing decision expiry compare-and-set failed');
    await this.audit.writeMandatory({ connection }, {
      event: 'pairing_expire',
      userPublicId: input.ownerUserPublicId,
      sessionPublicId: input.approvingSessionPublicId,
      clientPublicId: row.clientPublicId,
      pairingPublicId: row.publicId,
      subjectFingerprint: null,
      metadata: { reason: 'decision_deadline' },
    });
  }

  private decisionStatus(
    row: {
      publicId: PairingId;
      requestedScopeMask: number;
      requestedLifecycleMask: number;
      clientPublicId: string;
      clientName: string;
      installationId: string;
      createdAt: string;
      codeExpiresAt: string;
      decisionExpiresAt: string;
    },
    input: DecidePairingPersistenceInput,
    approvedScopeMask: number | null,
    approvedLifecycleMask: number | null,
    redeemExpiresAt: number | null,
    state: 3 | 5,
  ): PairingOwnerStatus {
    return buildPairingOwnerStatus({
      pairingId: row.publicId,
      state,
      createdAt: mysqlTimestampToMillis(row.createdAt),
      codeExpiresAt: mysqlTimestampToMillis(row.codeExpiresAt),
      decisionExpiresAt: mysqlTimestampToMillis(row.decisionExpiresAt),
      redeemExpiresAt,
      client: {
        clientId: parseClientId(row.clientPublicId),
        clientName: row.clientName,
        installationId: row.installationId,
      },
      requestedScopeMask: row.requestedScopeMask,
      requestedLifecycleMask: row.requestedLifecycleMask,
      approvedScopeMask,
      approvedLifecycleMask,
      boardIds: input.decision === 'approve' ? input.boardIds : null,
      lifetime: input.decision === 'approve' ? input.lifetime === 'session' ? 1 : 2 : null,
      decidedAt: input.now,
    }, this.crypto);
  }

  private async upsertClient(
    connection: PoolConnection,
    ownerUserDatabaseId: string,
    input: ClaimPairingPersistenceInput,
  ): Promise<string> {
    const [existingRows] = await connection.execute<Array<RowDataPacket & { id: string }>>(`
      SELECT CAST(id AS CHAR) AS id
      FROM mcp_clients
      WHERE owner_user_id = ? AND installation_id = ?
      FOR UPDATE
    `, [ownerUserDatabaseId, input.installationId]);
    const existing = existingRows[0];
    if (existing) {
      await connection.execute(`
        UPDATE mcp_clients
        SET display_name = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `, [input.clientName, new Date(input.now), new Date(input.now), existing.id]);
      return existing.id;
    }
    try {
      const [inserted] = await connection.execute<ResultSetHeader>(`
        INSERT INTO mcp_clients (
          public_id, owner_user_id, installation_id, display_name,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        input.clientPublicId,
        ownerUserDatabaseId,
        input.installationId,
        input.clientName,
        new Date(input.now),
        new Date(input.now),
        new Date(input.now),
      ]);
      return String(inserted.insertId);
    } catch (error) {
      if (isDuplicateKey(error)) throw new PairingCollisionError('client identifier collision');
      throw error;
    }
  }

  private async expireDuePairings(
    connection: PoolConnection,
    ownerUserDatabaseId: string,
    ownerUserPublicId: string,
    now: number,
  ): Promise<void> {
    const [rows] = await connection.execute<DuePairingRow[]>(`
      SELECT CAST(id AS CHAR) AS id, public_id AS publicId, CAST(grant_id AS CHAR) AS grantId
      FROM pairing_requests
      WHERE owner_user_id = ? AND (
        (state = 1 AND code_expires_at <= ?)
        OR (state = 2 AND decision_expires_at <= ?)
        OR (state = 3 AND redeem_expires_at <= ?)
      )
      ORDER BY id
      FOR UPDATE
    `, [ownerUserDatabaseId, new Date(now), new Date(now), new Date(now)]);
    const grantIds = rows.flatMap((row) => row.grantId === null ? [] : [row.grantId]);
    if (grantIds.length > 0) {
      const placeholders = grantIds.map(() => '?').join(', ');
      await connection.execute(
        `SELECT id FROM mcp_grants WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,
        grantIds,
      );
      await connection.execute(
        `SELECT id FROM mcp_grant_credentials WHERE grant_id IN (${placeholders}) ORDER BY id FOR UPDATE`,
        grantIds,
      );
      await connection.execute(`
        UPDATE mcp_grant_credentials
        SET status = 3, revoked_at = ?
        WHERE grant_id IN (${placeholders}) AND status = 1
      `, [new Date(now), ...grantIds]);
      await connection.execute(`
        UPDATE mcp_grants
        SET status = 4, revoked_at = ?, revoke_reason = 3, updated_at = ?
        WHERE id IN (${placeholders}) AND status = 1
      `, [new Date(now), new Date(now), ...grantIds]);
    }
    for (const row of rows) {
      const [result] = await connection.execute<ResultSetHeader>(`
        UPDATE pairing_requests
        SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
        WHERE id = ? AND state IN (1, 2, 3)
      `, [new Date(now), row.id]);
      if (result.affectedRows !== 1) throw new Error('pairing expiry compare-and-set failed');
      await this.audit.writeMandatory({ connection }, {
        event: 'pairing_expire',
        userPublicId: ownerUserPublicId,
        sessionPublicId: null,
        subjectFingerprint: null,
        pairingPublicId: row.publicId,
        metadata: { reason: 'deadline' },
      });
    }
  }
}

const mysqlTimestampToMillis = (value: string): number => {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isSafeInteger(parsed)) throw new Error('database returned an invalid timestamp');
  return parsed;
};

const timestampOrNull = (value: string | null): number | null => (
  value === null ? null : mysqlTimestampToMillis(value)
);

const isDuplicateKey = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
);
