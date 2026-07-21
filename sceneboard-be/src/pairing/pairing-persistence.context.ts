import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import { MysqlService } from '../database/mysql.service.js';
import type { PairingId } from '../common/ids/public-id.js';
import { CryptoService } from '../common/security/crypto.service.js';
import {
  BoardIdParserV1,
  BoardOperationRequestParserV1,
  normalizeActorContextV1,
  type BoardId,
  type ShortText,
} from '@sceneboard/board-schema';
import { parseClientId } from '../common/ids/public-id.js';
import { parseGrantId } from '../common/ids/public-id.js';
import {
  buildPairingClientSummary,
  buildPairingOwnerStatus,
  type PairingOwnerStatus,
} from './pairing.status.js';
import { buildPairingClientStatus, type PairingClientStatus } from './pairing-client.status.js';
import { buildGrantSummary, type GrantSummary } from '../grants/grant.status.js';
import { scopeValuesFromMask } from '../grants/scope-map.js';
import { BoardCreateService, type BoardCreateRequestV1 } from '../boards/board-create.service.js';
import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';
import type {
  ClaimPairingPersistenceInput,
  DecidePairingPersistenceInput,
  OwnerPairingPersistenceInput,
} from './pairing-persistence.types.js';

export type {
  CancelPairingPersistenceResult,
  ClaimPairingPersistenceInput,
  ClaimPairingPersistenceResult,
  ClientStatusPersistenceInput,
  ClientStatusPersistenceResult,
  CreatePairingPersistenceInput,
  CreatePairingPersistenceResult,
  DecidePairingPersistenceInput,
  DecidePairingPersistenceResult,
  OwnerPairingPersistenceInput,
  OwnerPairingPersistenceResult,
  RedeemPairingPersistenceInput,
  RedeemPairingPersistenceResult,
} from './pairing-persistence.types.js';

export class PairingCollisionError extends Error {}

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

export class PairingPersistenceContext {
  constructor(
    protected readonly mysql: MysqlService,
    protected readonly audit: AuditRepository,
    protected readonly crypto: CryptoService,
    protected readonly boardCreate: BoardCreateService,
  ) {}

  protected async applyOwnerLazyExpiry(
    connection: PoolConnection,
    row: ClientPairingRow,
    familyRows: Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>,
    input: Omit<OwnerPairingPersistenceInput, 'pairingId'>,
  ): Promise<void> {
    if (row.state === 1 && mysqlTimestampToMillis(row.codeExpiresAt) <= input.now) {
      const [expired] = await connection.execute<ResultSetHeader>(
        `
        UPDATE pairing_requests
        SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
        WHERE id = ? AND state = 1 AND code_expires_at <= ?
      `,
        [new Date(input.now), row.id, new Date(input.now)],
      );
      if (expired.affectedRows !== 1)
        throw new Error('created pairing expiry compare-and-set failed');
      await this.audit.writeMandatory(
        { connection },
        {
          event: 'pairing_expire',
          userPublicId: input.ownerUserPublicId,
          sessionPublicId: input.sessionPublicId,
          pairingPublicId: row.publicId,
          subjectFingerprint: null,
          metadata: { reason: 'code_deadline' },
        },
      );
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
  }

  protected ownerStatusFromRow(
    row: ClientPairingRow,
    boardIds: BoardId[] | null,
  ): PairingOwnerStatus {
    const client =
      row.clientPublicId === null || row.clientName === null || row.installationId === null
        ? null
        : {
            clientId: parseClientId(row.clientPublicId),
            clientName: row.clientName,
            installationId: row.installationId,
          };
    return buildPairingOwnerStatus(
      {
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
      },
      this.crypto,
    );
  }

  protected async lockPairingFamily(
    connection: PoolConnection,
    pairingId: PairingId,
    ownerUserDatabaseId?: string,
  ): Promise<Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>> {
    const [links] = await connection.execute<Array<RowDataPacket & { familyPublicId: string }>>(
      `
      SELECT s.family_public_id AS familyPublicId
      FROM pairing_requests p
      JOIN auth_sessions s ON s.id = p.source_session_id
      WHERE p.public_id = ?${ownerUserDatabaseId === undefined ? '' : ' AND p.owner_user_id = ?'}
      LIMIT 1
    `,
      ownerUserDatabaseId === undefined ? [pairingId] : [pairingId, ownerUserDatabaseId],
    );
    const familyPublicId = links[0]?.familyPublicId;
    if (familyPublicId === undefined) return [];
    const [rows] = await connection.execute<
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
      WHERE family_public_id = ?
      ORDER BY id
      FOR UPDATE
    `,
      [familyPublicId],
    );
    return rows;
  }

  protected async lockClientPairing(
    connection: PoolConnection,
    pairingId: PairingId,
    ownerUserDatabaseId?: string,
  ): Promise<ClientPairingRow | undefined> {
    const [rows] = await connection.execute<ClientPairingRow[]>(
      `
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
    `,
      ownerUserDatabaseId === undefined ? [pairingId] : [pairingId, ownerUserDatabaseId],
    );
    return rows[0];
  }

  protected async lockGrantForPairing(
    connection: PoolConnection,
    row: ClientPairingRow,
  ): Promise<void> {
    if (row.grantDatabaseId === null) throw new Error('approved pairing has no grant');
    const [grants] = await connection.execute<
      Array<
        RowDataPacket & {
          publicId: string;
          status: number;
          expiresAt: string;
          createdAt: string;
          activatedAt: string | null;
          lastUsedAt: string | null;
          revokedAt: string | null;
        }
      >
    >(
      `
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
    `,
      [row.grantDatabaseId],
    );
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

  protected hasValidProof(
    row: ClientPairingRow | undefined,
    proofChallenge: Buffer,
  ): row is ClientPairingRow {
    return (
      row !== undefined &&
      row.proofChallenge !== null &&
      this.crypto.constantTimeEqual(row.proofChallenge, proofChallenge)
    );
  }

  protected hasLiveFamilySession(
    rows: Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>,
    now: number,
  ): boolean {
    return rows.some(
      (row) =>
        row.status === 1 &&
        mysqlTimestampToMillis(row.idleExpiresAt) > now &&
        mysqlTimestampToMillis(row.absoluteExpiresAt) > now,
    );
  }

  protected clientStatusFromRow(row: ClientPairingRow, now: number): PairingClientStatus {
    return buildPairingClientStatus(
      {
        pairingId: row.publicId,
        state: row.state,
        claimedAt: this.timestampRequired(row.claimedAt),
        decisionExpiresAt: timestampOrNull(row.decisionExpiresAt),
        redeemExpiresAt: timestampOrNull(row.redeemExpiresAt),
      },
      now,
    );
  }

  protected async expireClaimedPairing(
    connection: PoolConnection,
    row: ClientPairingRow,
    now: number,
    reason: 'decision_deadline',
  ): Promise<void> {
    const [expired] = await connection.execute<ResultSetHeader>(
      `
      UPDATE pairing_requests SET state = 7, updated_at = ?
      WHERE id = ? AND state = 2 AND decision_expires_at <= ?
    `,
      [new Date(now), row.id, new Date(now)],
    );
    if (expired.affectedRows !== 1) throw new Error('pairing status expiry compare-and-set failed');
    await this.audit.writeMandatory(
      { connection },
      {
        event: 'pairing_expire',
        userPublicId: row.ownerUserPublicId,
        sessionPublicId: row.sourceSessionPublicId,
        clientPublicId: row.clientPublicId,
        pairingPublicId: row.publicId,
        subjectFingerprint: null,
        metadata: { reason },
      },
    );
  }

  protected async expireApprovedPairing(
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
    await connection.execute(
      `
      UPDATE mcp_grant_credentials
      SET status = 3, revoked_at = ?
      WHERE grant_id = ? AND status = 1
    `,
      [new Date(now), row.grantDatabaseId],
    );
    const [grantResult] = await connection.execute<ResultSetHeader>(
      `
      UPDATE mcp_grants
      SET status = 4, revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE id = ? AND status = 1
    `,
      [new Date(now), reason === 'session_ended' ? 2 : 3, new Date(now), row.grantDatabaseId],
    );
    if (grantResult.affectedRows !== 1)
      throw new Error('pending grant expiry compare-and-set failed');
    const [pairingResult] = await connection.execute<ResultSetHeader>(
      `
      UPDATE pairing_requests SET state = 7, updated_at = ?
      WHERE id = ? AND state = 3
    `,
      [new Date(now), row.id],
    );
    if (pairingResult.affectedRows !== 1)
      throw new Error('approved pairing expiry compare-and-set failed');
    await this.audit.writeMandatory(
      { connection },
      {
        event: 'grant_expire',
        userPublicId: row.ownerUserPublicId,
        sessionPublicId: row.sourceSessionPublicId,
        clientPublicId: row.clientPublicId,
        grantPublicId: row.grantPublicId,
        pairingPublicId: row.publicId,
        subjectFingerprint: null,
        metadata: { reason },
      },
    );
    await this.audit.writeMandatory(
      { connection },
      {
        event: 'pairing_expire',
        userPublicId: row.ownerUserPublicId,
        sessionPublicId: row.sourceSessionPublicId,
        clientPublicId: row.clientPublicId,
        grantPublicId: row.grantPublicId,
        pairingPublicId: row.publicId,
        subjectFingerprint: null,
        metadata: { reason },
      },
    );
  }

  protected async readGrantBoardIds(
    connection: PoolConnection,
    grantDatabaseId: string,
  ): Promise<BoardId[]> {
    const [rows] = await connection.execute<Array<RowDataPacket & { boardPublicId: string }>>(
      `
      SELECT board_public_id AS boardPublicId
      FROM mcp_grant_boards
      WHERE grant_id = ?
      ORDER BY board_public_id
    `,
      [grantDatabaseId],
    );
    return rows.map((row) => {
      const parsed = BoardIdParserV1.parse(row.boardPublicId);
      if (!parsed.ok) throw new Error('database returned an invalid board public ID');
      return parsed.data.value;
    });
  }

  protected redeemedGrantFromRow(
    row: ClientPairingRow,
    boardIds: BoardId[],
    now: number,
  ): GrantSummary {
    if (
      row.grantPublicId === null ||
      row.clientPublicId === null ||
      row.clientName === null ||
      row.installationId === null ||
      row.approvedScopeMask === null ||
      row.approvedLifecycleMask === null ||
      row.lifetime === null ||
      row.grantCreatedAt === null ||
      row.grantExpiresAt === null
    )
      throw new Error('approved pairing has incomplete grant data');
    return buildGrantSummary({
      grantId: parseGrantId(row.grantPublicId),
      client: buildPairingClientSummary(
        {
          clientId: parseClientId(row.clientPublicId),
          clientName: row.clientName,
          installationId: row.installationId,
        },
        this.crypto,
      ),
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

  protected timestampRequired(value: string | null): number {
    if (value === null) throw new Error('database returned a missing timestamp');
    return mysqlTimestampToMillis(value);
  }

  protected async expirePendingDecision(
    connection: PoolConnection,
    row: { id: string; publicId: PairingId; clientPublicId: string },
    input: DecidePairingPersistenceInput,
  ): Promise<void> {
    const [expired] = await connection.execute<ResultSetHeader>(
      `
      UPDATE pairing_requests
      SET state = 7, updated_at = ?
      WHERE id = ? AND state = 2 AND decision_expires_at <= ?
    `,
      [new Date(input.now), row.id, new Date(input.now)],
    );
    if (expired.affectedRows !== 1)
      throw new Error('pairing decision expiry compare-and-set failed');
    await this.audit.writeMandatory(
      { connection },
      {
        event: 'pairing_expire',
        userPublicId: input.ownerUserPublicId,
        sessionPublicId: input.approvingSessionPublicId,
        clientPublicId: row.clientPublicId,
        pairingPublicId: row.publicId,
        subjectFingerprint: null,
        metadata: { reason: 'decision_deadline' },
      },
    );
  }

  protected decisionStatus(
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
    boardIds: BoardId[] | null,
  ): PairingOwnerStatus {
    return buildPairingOwnerStatus(
      {
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
        boardIds,
        lifetime: input.decision === 'approve' ? (input.lifetime === 'session' ? 1 : 2) : null,
        decidedAt: input.now,
      },
      this.crypto,
    );
  }

  protected ownerBoardCreateContext(
    ownerUserDatabaseId: string,
    ownerUserPublicId: string,
  ): AuthorizedBoardContextV1 {
    const actor = normalizeActorContextV1({
      principalKind: 'user',
      principalId: ownerUserPublicId,
      grantId: null,
      scopes: scopeValuesFromMask(127),
    });
    if (!actor.ok) throw new Error('owner actor context is invalid');
    const ownerUserPk = BigInt(ownerUserDatabaseId);
    return {
      actor: actor.data.value,
      ownerUserPk,
      access: { kind: 'owner', ownerUserPk },
      createBinding: null,
      artifactCapabilityPolicy: {
        allowedArtifactRequestCapabilities: [],
        policyEpoch: Buffer.alloc(16).toString('base64url'),
      },
    };
  }

  protected pairingBoardCreateRequest(
    pairingId: PairingId,
    title: ShortText,
  ): BoardCreateRequestV1 {
    const parsed = BoardOperationRequestParserV1.parse({
      protocolVersion: 1,
      requestId: `pairing_${pairingId}`,
      type: 'board.create',
      idempotencyKey: `pairing-board-create:${pairingId}`,
      title,
    });
    if (!parsed.ok || parsed.data.value.type !== 'board.create') {
      throw new Error('pairing board create request is invalid');
    }
    return parsed.data.value as BoardCreateRequestV1;
  }

  protected async upsertClient(
    connection: PoolConnection,
    ownerUserDatabaseId: string,
    input: ClaimPairingPersistenceInput,
  ): Promise<string> {
    const [existingRows] = await connection.execute<Array<RowDataPacket & { id: string }>>(
      `
      SELECT CAST(id AS CHAR) AS id
      FROM mcp_clients
      WHERE owner_user_id = ? AND installation_id = ?
      FOR UPDATE
    `,
      [ownerUserDatabaseId, input.installationId],
    );
    const existing = existingRows[0];
    if (existing) {
      await connection.execute(
        `
        UPDATE mcp_clients
        SET display_name = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `,
        [input.clientName, new Date(input.now), new Date(input.now), existing.id],
      );
      return existing.id;
    }
    try {
      const [inserted] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO mcp_clients (
          public_id, owner_user_id, installation_id, display_name,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        [
          input.clientPublicId,
          ownerUserDatabaseId,
          input.installationId,
          input.clientName,
          new Date(input.now),
          new Date(input.now),
          new Date(input.now),
        ],
      );
      return String(inserted.insertId);
    } catch (error) {
      if (isDuplicateKey(error)) throw new PairingCollisionError('client identifier collision');
      throw error;
    }
  }

  protected async expireDuePairings(
    connection: PoolConnection,
    ownerUserDatabaseId: string,
    ownerUserPublicId: string,
    now: number,
  ): Promise<void> {
    const [rows] = await connection.execute<DuePairingRow[]>(
      `
      SELECT CAST(id AS CHAR) AS id, public_id AS publicId, CAST(grant_id AS CHAR) AS grantId
      FROM pairing_requests
      WHERE owner_user_id = ? AND (
        (state = 1 AND code_expires_at <= ?)
        OR (state = 2 AND decision_expires_at <= ?)
        OR (state = 3 AND redeem_expires_at <= ?)
      )
      ORDER BY id
      FOR UPDATE
    `,
      [ownerUserDatabaseId, new Date(now), new Date(now), new Date(now)],
    );
    const grantIds = rows.flatMap((row) => (row.grantId === null ? [] : [row.grantId]));
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
      await connection.execute(
        `
        UPDATE mcp_grant_credentials
        SET status = 3, revoked_at = ?
        WHERE grant_id IN (${placeholders}) AND status = 1
      `,
        [new Date(now), ...grantIds],
      );
      await connection.execute(
        `
        UPDATE mcp_grants
        SET status = 4, revoked_at = ?, revoke_reason = 3, updated_at = ?
        WHERE id IN (${placeholders}) AND status = 1
      `,
        [new Date(now), new Date(now), ...grantIds],
      );
    }
    for (const row of rows) {
      const [result] = await connection.execute<ResultSetHeader>(
        `
        UPDATE pairing_requests
        SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
        WHERE id = ? AND state IN (1, 2, 3)
      `,
        [new Date(now), row.id],
      );
      if (result.affectedRows !== 1) throw new Error('pairing expiry compare-and-set failed');
      await this.audit.writeMandatory(
        { connection },
        {
          event: 'pairing_expire',
          userPublicId: ownerUserPublicId,
          sessionPublicId: null,
          subjectFingerprint: null,
          pairingPublicId: row.publicId,
          metadata: { reason: 'deadline' },
        },
      );
    }
  }
}

export const mysqlTimestampToMillis = (value: string): number => {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isSafeInteger(parsed)) throw new Error('database returned an invalid timestamp');
  return parsed;
};

export const timestampOrNull = (value: string | null): number | null =>
  value === null ? null : mysqlTimestampToMillis(value);

export const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY';
