import type { BoardId } from '@sceneboard/board-schema';
import { BoardIdParserV1 } from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import { parseClientId, parseGrantId, type GrantId } from '../common/ids/public-id.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import { buildPairingClientSummary } from '../pairing/pairing.status.js';
import type { GrantCursorTuple } from './grant-cursor.service.js';
import { buildGrantSummary, type GrantSummary } from './grant.status.js';

interface GrantRow extends RowDataPacket {
  id: string;
  publicId: string;
  ownerUserPublicId: string;
  clientPublicId: string;
  clientName: string;
  installationId: string;
  sourceSessionPublicId: string | null;
  scopeMask: number;
  lifecycleMask: number;
  lifetime: number;
  status: number;
  expiresAt: string;
  activatedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface GrantListPersistenceInput {
  ownerUserDatabaseId: string;
  ownerUserPublicId: string;
  cursor: GrantCursorTuple | null;
  limit: number;
  now: number;
}

export interface GrantListPersistenceResult {
  grants: GrantSummary[];
  nextTuple: GrantCursorTuple | null;
}

export interface GrantMutationPersistenceInput {
  grantId: GrantId;
  ownerUserDatabaseId: string;
  ownerUserPublicId: string;
  sessionPublicId: string;
  now: number;
}

export interface GrantRotationPersistenceInput extends GrantMutationPersistenceInput {
  credentialLocator: Buffer;
  credentialHash: Buffer;
}

export type RevokeGrantPersistenceResult =
  | { kind: 'revoked' }
  | { kind: 'not_found' | 'service_unavailable' };

export type RotateGrantPersistenceResult =
  | { kind: 'rotated'; grant: GrantSummary }
  | { kind: 'not_found' | 'not_active' | 'collision' | 'service_unavailable' };

class GrantCredentialCollisionError extends Error {}

export class GrantRepository {
  constructor(
    private readonly mysql: MysqlService,
    private readonly audit: AuditRepository,
    private readonly crypto: CryptoService,
  ) {}

  async list(input: GrantListPersistenceInput): Promise<GrantListPersistenceResult> {
    return this.mysql.withConnection((connection) =>
      withTransaction(connection, 'REPEATABLE READ', async () => {
        const cursorClause =
          input.cursor === null ? '' : ' AND (g.created_at < ? OR (g.created_at = ? AND g.id < ?))';
        const cursorValues =
          input.cursor === null
            ? []
            : [
                mysqlDate(input.cursor.createdAt),
                mysqlDate(input.cursor.createdAt),
                input.cursor.id,
              ];
        const [allRows] = await connection.execute<GrantRow[]>(
          `
        SELECT
          CAST(g.id AS CHAR) AS id,
          g.public_id AS publicId,
          u.public_id AS ownerUserPublicId,
          c.public_id AS clientPublicId,
          c.display_name AS clientName,
          c.installation_id AS installationId,
          s.public_id AS sourceSessionPublicId,
          g.scope_mask AS scopeMask,
          g.lifecycle_mask AS lifecycleMask,
          g.lifetime,
          g.status,
          g.expires_at AS expiresAt,
          g.activated_at AS activatedAt,
          g.last_used_at AS lastUsedAt,
          g.revoked_at AS revokedAt,
          g.created_at AS createdAt
        FROM mcp_grants g
        JOIN users u ON u.id = g.owner_user_id
        JOIN mcp_clients c ON c.id = g.client_id
        LEFT JOIN auth_sessions s ON s.id = g.source_session_id
        WHERE g.owner_user_id = ?${cursorClause}
        ORDER BY g.created_at DESC, g.id DESC
        LIMIT ${input.limit + 1}
      `,
          [input.ownerUserDatabaseId, ...cursorValues],
        );
        const hasNext = allRows.length > input.limit;
        const rows = allRows.slice(0, input.limit);
        if (rows.length === 0) return { grants: [], nextTuple: null };
        const boardMap = await this.readBoardMap(
          connection,
          rows.map((row) => row.id),
        );
        const grants = rows.map((row) =>
          this.summaryFromRow(
            row,
            boardMap.get(row.id) ?? [],
            row.status === 2 && millis(row.expiresAt) <= input.now ? 4 : row.status,
          ),
        );
        const last = rows.at(-1);
        return {
          grants,
          nextTuple:
            hasNext && last !== undefined ? { createdAt: iso(last.createdAt), id: last.id } : null,
        };
      }),
    );
  }

  async revoke(input: GrantMutationPersistenceInput): Promise<RevokeGrantPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const prepared = await this.prepareMutation(connection, input);
          if (prepared === null) return { kind: 'not_found' as const };
          const { grant, pairing, familyRows } = prepared;
          const activeFamilyRequired = grant.status === 1 || grant.lifetime === 1;
          const familyLive = !activeFamilyRequired || hasLiveFamily(familyRows, input.now);
          const expired =
            millis(grant.expiresAt) <= input.now ||
            (pairing !== null && millis(pairing.redeemExpiresAt) <= input.now) ||
            !familyLive;

          if ((grant.status === 1 || grant.status === 2) && expired) {
            await this.expireLockedGrant(
              connection,
              grant,
              pairing,
              input,
              familyLive ? 'deadline' : 'session_ended',
            );
            grant.status = 4;
          } else if (grant.status === 1) {
            if (pairing === null || pairing.state !== 3)
              throw new Error('pending grant has no approved pairing');
            await this.revokeCredentials(connection, grant.id, input.now, 3);
            await this.updateGrantTerminal(connection, grant.id, 3, 1, input.now, 1);
            const [pairingResult] = await connection.execute<ResultSetHeader>(
              `
            UPDATE pairing_requests SET state = 6, updated_at = ?
            WHERE id = ? AND state = 3
          `,
              [new Date(input.now), pairing.id],
            );
            if (pairingResult.affectedRows !== 1)
              throw new Error('pending pairing revoke compare-and-set failed');
            await this.audit.writeMandatory(
              { connection },
              {
                event: 'pairing_cancel',
                userPublicId: input.ownerUserPublicId,
                sessionPublicId: input.sessionPublicId,
                clientPublicId: grant.clientPublicId,
                grantPublicId: grant.publicId,
                pairingPublicId: pairing.publicId,
                subjectFingerprint: null,
                metadata: { reason: 'grant_revoked' },
              },
            );
            grant.status = 3;
          } else if (grant.status === 2) {
            await this.revokeCredentials(connection, grant.id, input.now, 3);
            await this.updateGrantTerminal(connection, grant.id, 3, 1, input.now, 2);
            grant.status = 3;
          }

          await this.audit.writeMandatory(
            { connection },
            {
              event: 'grant_revoke',
              userPublicId: input.ownerUserPublicId,
              sessionPublicId: input.sessionPublicId,
              clientPublicId: grant.clientPublicId,
              grantPublicId: grant.publicId,
              pairingPublicId: pairing?.publicId ?? null,
              subjectFingerprint: null,
              metadata: { reason: grant.status === 3 ? 'owner' : 'already_terminal' },
            },
          );
          return { kind: 'revoked' as const };
        }),
      );
    } catch {
      return { kind: 'service_unavailable' };
    }
  }

  async rotate(input: GrantRotationPersistenceInput): Promise<RotateGrantPersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const prepared = await this.prepareMutation(connection, input);
          if (prepared === null) return { kind: 'not_found' as const };
          const { grant, pairing, familyRows, credentialIds } = prepared;
          const familyLive = grant.lifetime !== 1 || hasLiveFamily(familyRows, input.now);
          if (grant.status === 2 && (millis(grant.expiresAt) <= input.now || !familyLive)) {
            await this.expireLockedGrant(
              connection,
              grant,
              pairing,
              input,
              familyLive ? 'deadline' : 'session_ended',
            );
            return { kind: 'not_active' as const };
          }
          if (grant.status !== 2) return { kind: 'not_active' as const };
          if (credentialIds.length !== 1)
            throw new Error('active grant must have exactly one active credential');

          const [rotated] = await connection.execute<ResultSetHeader>(
            `
          UPDATE mcp_grant_credentials
          SET status = 2, revoked_at = ?
          WHERE id = ? AND grant_id = ? AND status = 1
        `,
            [new Date(input.now), credentialIds[0], grant.id],
          );
          if (rotated.affectedRows !== 1)
            throw new Error('credential rotation compare-and-set failed');
          try {
            await connection.execute(
              `
            INSERT INTO mcp_grant_credentials (
              grant_id, locator, token_hash, status, rotated_from_id, created_at
            ) VALUES (?, ?, ?, 1, ?, ?)
          `,
              [
                grant.id,
                input.credentialLocator,
                input.credentialHash,
                credentialIds[0],
                new Date(input.now),
              ],
            );
          } catch (error) {
            if (isDuplicateKey(error))
              throw new GrantCredentialCollisionError('grant credential locator collision');
            throw error;
          }
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'grant_rotate',
              userPublicId: input.ownerUserPublicId,
              sessionPublicId: input.sessionPublicId,
              clientPublicId: grant.clientPublicId,
              grantPublicId: grant.publicId,
              pairingPublicId: null,
              subjectFingerprint: null,
              metadata: { reason: 'owner' },
            },
          );
          const boardIds = await this.readBoardIds(connection, grant.id);
          return { kind: 'rotated' as const, grant: this.summaryFromRow(grant, boardIds, 2) };
        }),
      );
    } catch (error) {
      if (error instanceof GrantCredentialCollisionError) return { kind: 'collision' };
      return { kind: 'service_unavailable' };
    }
  }

  private async prepareMutation(
    connection: PoolConnection,
    input: GrantMutationPersistenceInput,
  ): Promise<{
    grant: GrantRow;
    pairing: { id: string; publicId: string; state: number; redeemExpiresAt: string } | null;
    familyRows: Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>;
    credentialIds: string[];
  } | null> {
    const [links] = await connection.execute<
      Array<
        RowDataPacket & {
          grantDatabaseId: string;
          grantFamilyPublicId: string | null;
          pairingFamilyPublicId: string | null;
        }
      >
    >(
      `
      SELECT
        CAST(g.id AS CHAR) AS grantDatabaseId,
        gs.family_public_id AS grantFamilyPublicId,
        ps.family_public_id AS pairingFamilyPublicId
      FROM mcp_grants g
      LEFT JOIN auth_sessions gs ON gs.id = g.source_session_id
      LEFT JOIN pairing_requests p ON p.grant_id = g.id AND p.state = 3
      LEFT JOIN auth_sessions ps ON ps.id = p.source_session_id
      WHERE g.public_id = ? AND g.owner_user_id = ?
      LIMIT 1
    `,
      [input.grantId, input.ownerUserDatabaseId],
    );
    const link = links[0];
    if (link === undefined) return null;
    const familyIds = [link.grantFamilyPublicId, link.pairingFamilyPublicId]
      .filter((value): value is string => value !== null)
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort();
    const familyRows: Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }> =
      [];
    if (familyIds.length > 0) {
      const placeholders = familyIds.map(() => '?').join(', ');
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
        WHERE family_public_id IN (${placeholders})
        ORDER BY family_public_id, id
        FOR UPDATE
      `,
        familyIds,
      );
      familyRows.push(...rows);
    }
    const [pairings] = await connection.execute<
      Array<
        RowDataPacket & {
          id: string;
          publicId: string;
          state: number;
          redeemExpiresAt: string;
        }
      >
    >(
      `
      SELECT CAST(id AS CHAR) AS id, public_id AS publicId, state, redeem_expires_at AS redeemExpiresAt
      FROM pairing_requests
      WHERE grant_id = ? AND owner_user_id = ? AND state = 3
      ORDER BY id
      FOR UPDATE
    `,
      [link.grantDatabaseId, input.ownerUserDatabaseId],
    );
    const [grants] = await connection.execute<GrantRow[]>(
      `
      SELECT
        CAST(g.id AS CHAR) AS id,
        g.public_id AS publicId,
        u.public_id AS ownerUserPublicId,
        c.public_id AS clientPublicId,
        c.display_name AS clientName,
        c.installation_id AS installationId,
        s.public_id AS sourceSessionPublicId,
        g.scope_mask AS scopeMask,
        g.lifecycle_mask AS lifecycleMask,
        g.lifetime,
        g.status,
        g.expires_at AS expiresAt,
        g.activated_at AS activatedAt,
        g.last_used_at AS lastUsedAt,
        g.revoked_at AS revokedAt,
        g.created_at AS createdAt
      FROM mcp_grants g
      JOIN users u ON u.id = g.owner_user_id
      JOIN mcp_clients c ON c.id = g.client_id
      LEFT JOIN auth_sessions s ON s.id = g.source_session_id
      WHERE g.id = ? AND g.owner_user_id = ?
      FOR UPDATE
    `,
      [link.grantDatabaseId, input.ownerUserDatabaseId],
    );
    const grant = grants[0];
    if (grant === undefined) return null;
    const [credentials] = await connection.execute<Array<RowDataPacket & { id: string }>>(
      `
      SELECT CAST(id AS CHAR) AS id
      FROM mcp_grant_credentials
      WHERE grant_id = ? AND status = 1
      ORDER BY id
      FOR UPDATE
    `,
      [grant.id],
    );
    return {
      grant,
      pairing: pairings[0] ?? null,
      familyRows,
      credentialIds: credentials.map((row) => row.id),
    };
  }

  private async expireLockedGrant(
    connection: PoolConnection,
    grant: GrantRow,
    pairing: { id: string; publicId: string; state: number } | null,
    input: GrantMutationPersistenceInput,
    reason: 'deadline' | 'session_ended',
  ): Promise<void> {
    await this.revokeCredentials(connection, grant.id, input.now, 3);
    await this.updateGrantTerminal(
      connection,
      grant.id,
      4,
      reason === 'session_ended' ? 2 : 3,
      input.now,
      grant.status,
    );
    if (pairing?.state === 3) {
      const [result] = await connection.execute<ResultSetHeader>(
        `
        UPDATE pairing_requests SET state = 7, updated_at = ? WHERE id = ? AND state = 3
      `,
        [new Date(input.now), pairing.id],
      );
      if (result.affectedRows !== 1)
        throw new Error('pending pairing expiry compare-and-set failed');
      await this.audit.writeMandatory(
        { connection },
        {
          event: 'pairing_expire',
          userPublicId: input.ownerUserPublicId,
          sessionPublicId: input.sessionPublicId,
          clientPublicId: grant.clientPublicId,
          grantPublicId: grant.publicId,
          pairingPublicId: pairing.publicId,
          subjectFingerprint: null,
          metadata: { reason },
        },
      );
    }
    await this.audit.writeMandatory(
      { connection },
      {
        event: 'grant_expire',
        userPublicId: input.ownerUserPublicId,
        sessionPublicId: input.sessionPublicId,
        clientPublicId: grant.clientPublicId,
        grantPublicId: grant.publicId,
        pairingPublicId: pairing?.publicId ?? null,
        subjectFingerprint: null,
        metadata: { reason },
      },
    );
  }

  private async updateGrantTerminal(
    connection: PoolConnection,
    grantDatabaseId: string,
    status: 3 | 4,
    reason: 1 | 2 | 3,
    now: number,
    expectedStatus: number,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE mcp_grants
      SET status = ?, revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `,
      [status, new Date(now), reason, new Date(now), grantDatabaseId, expectedStatus],
    );
    if (result.affectedRows !== 1) throw new Error('grant terminal compare-and-set failed');
  }

  private async revokeCredentials(
    connection: PoolConnection,
    grantDatabaseId: string,
    now: number,
    status: 2 | 3,
  ): Promise<void> {
    await connection.execute(
      `
      UPDATE mcp_grant_credentials SET status = ?, revoked_at = ?
      WHERE grant_id = ? AND status = 1
    `,
      [status, new Date(now), grantDatabaseId],
    );
  }

  private async readBoardMap(
    connection: PoolConnection,
    grantIds: string[],
  ): Promise<Map<string, BoardId[]>> {
    const placeholders = grantIds.map(() => '?').join(', ');
    const [rows] = await connection.execute<
      Array<RowDataPacket & { grantId: string; boardPublicId: string }>
    >(
      `
      SELECT CAST(grant_id AS CHAR) AS grantId, board_public_id AS boardPublicId
      FROM mcp_grant_boards
      WHERE grant_id IN (${placeholders})
      ORDER BY grant_id, board_public_id
    `,
      grantIds,
    );
    const result = new Map<string, BoardId[]>();
    for (const row of rows) {
      const values = result.get(row.grantId) ?? [];
      values.push(parseBoardId(row.boardPublicId));
      result.set(row.grantId, values);
    }
    return result;
  }

  private async readBoardIds(connection: PoolConnection, grantId: string): Promise<BoardId[]> {
    return (await this.readBoardMap(connection, [grantId])).get(grantId) ?? [];
  }

  private summaryFromRow(row: GrantRow, boardIds: BoardId[], status: number): GrantSummary {
    return buildGrantSummary({
      grantId: parseGrantId(row.publicId),
      client: buildPairingClientSummary(
        {
          clientId: parseClientId(row.clientPublicId),
          clientName: row.clientName,
          installationId: row.installationId,
        },
        this.crypto,
      ),
      scopeMask: row.scopeMask,
      lifecycleMask: row.lifecycleMask,
      boardIds,
      lifetime: row.lifetime,
      status,
      createdAt: millis(row.createdAt),
      activatedAt: nullableMillis(row.activatedAt),
      lastUsedAt: nullableMillis(row.lastUsedAt),
      expiresAt: millis(row.expiresAt),
      revokedAt: nullableMillis(row.revokedAt),
    });
  }
}

const millis = (value: string): number => {
  const result = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isSafeInteger(result)) throw new Error('database returned an invalid timestamp');
  return result;
};
const nullableMillis = (value: string | null): number | null =>
  value === null ? null : millis(value);
const iso = (value: string): string => new Date(millis(value)).toISOString();
const mysqlDate = (value: string): Date => new Date(Date.parse(value));
const parseBoardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new Error('database returned an invalid board public ID');
  return parsed.data.value;
};
const hasLiveFamily = (
  rows: Array<{ status: number; idleExpiresAt: string; absoluteExpiresAt: string }>,
  now: number,
): boolean =>
  rows.some(
    (row) =>
      row.status === 1 && millis(row.idleExpiresAt) > now && millis(row.absoluteExpiresAt) > now,
  );
const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY';
