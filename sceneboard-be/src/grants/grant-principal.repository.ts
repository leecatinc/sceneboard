import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { BoardIdParserV1, type BoardId } from '@sceneboard/board-schema';

import { AuditRepository } from '../audit/audit.repository.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import { buildPairingClientSummary } from '../pairing/pairing.status.js';
import type { GrantPrincipalPersistence, GrantPrincipalRecord } from './actor-context.service.js';
import { lifecycleValuesFromMask, scopeValuesFromMask } from './scope-map.js';

interface GrantPrincipalRow extends RowDataPacket {
  ownerUserDatabaseId: string;
  ownerUserPublicId: string;
  ownerUserStatus: number;
  grantDatabaseId: string;
  grantPublicId: string;
  grantStatus: number;
  grantLifetime: number;
  grantExpiresAt: string;
  sourceFamilyPublicId: string | null;
  currentFamilySessionId: string | null;
  clientPublicId: string;
  clientName: string;
  installationId: string;
  credentialDatabaseId: string;
  credentialStatus: number;
  scopeMask: number;
  lifecycleMask: number;
  activatedAt: string | null;
}

export class GrantPrincipalRepository implements GrantPrincipalPersistence {
  constructor(
    private readonly mysql: MysqlService,
    private readonly audit: AuditRepository,
    private readonly crypto: CryptoService,
  ) {}

  async resolve(input: {
    locator: Buffer;
    tokenHash: Buffer;
    now: number;
  }): Promise<GrantPrincipalRecord | null> {
    return this.mysql.withConnection((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const [rows] = await connection.execute<GrantPrincipalRow[]>(
          `
        SELECT
          CAST(u.id AS CHAR) AS ownerUserDatabaseId,
          u.public_id AS ownerUserPublicId,
          u.status AS ownerUserStatus,
          CAST(g.id AS CHAR) AS grantDatabaseId,
          g.public_id AS grantPublicId,
          g.status AS grantStatus,
          g.lifetime AS grantLifetime,
          g.expires_at AS grantExpiresAt,
          source.family_public_id AS sourceFamilyPublicId,
          CAST(current_family.id AS CHAR) AS currentFamilySessionId,
          client.public_id AS clientPublicId,
          client.display_name AS clientName,
          client.installation_id AS installationId,
          CAST(credential.id AS CHAR) AS credentialDatabaseId,
          credential.status AS credentialStatus,
          g.scope_mask AS scopeMask,
          g.lifecycle_mask AS lifecycleMask,
          g.activated_at AS activatedAt
        FROM mcp_grant_credentials credential
        JOIN mcp_grants g ON g.id = credential.grant_id
        JOIN mcp_clients client ON client.id = g.client_id
        JOIN users u ON u.id = g.owner_user_id
        LEFT JOIN auth_sessions source ON source.id = g.source_session_id
        LEFT JOIN auth_sessions current_family
          ON current_family.family_public_id = source.family_public_id
          AND current_family.status = 1
          AND current_family.idle_expires_at > ?
          AND current_family.absolute_expires_at > ?
        WHERE credential.locator = ? AND credential.token_hash = ?
        ORDER BY current_family.id
        FOR UPDATE
      `,
          [new Date(input.now), new Date(input.now), input.locator, input.tokenHash],
        );
        if (rows.length === 0) return null;
        if (rows.length !== 1) throw new Error('grant family has multiple active session rows');
        const row = rows[0];
        if (row === undefined) return null;
        if (row.ownerUserStatus !== 1 || row.grantStatus !== 2 || row.credentialStatus !== 1)
          return null;
        const deadlineExpired = millis(row.grantExpiresAt) <= input.now;
        const familyEnded = row.grantLifetime === 1 && row.currentFamilySessionId === null;
        if (deadlineExpired || familyEnded) {
          const reason = familyEnded ? 'session_ended' : 'deadline';
          const [credentials] = await connection.execute<ResultSetHeader>(
            `
          UPDATE mcp_grant_credentials
          SET status = 3, revoked_at = ?
          WHERE grant_id = ? AND status = 1
        `,
            [new Date(input.now), row.grantDatabaseId],
          );
          if (credentials.affectedRows < 1)
            throw new Error('active grant has no active credential');
          const [grant] = await connection.execute<ResultSetHeader>(
            `
          UPDATE mcp_grants
          SET status = 4, revoked_at = ?, revoke_reason = ?, updated_at = ?
          WHERE id = ? AND status = 2
        `,
            [new Date(input.now), familyEnded ? 2 : 3, new Date(input.now), row.grantDatabaseId],
          );
          if (grant.affectedRows !== 1) throw new Error('grant expiry compare-and-set failed');
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'grant_expire',
              actorPublicId: row.clientPublicId,
              userPublicId: row.ownerUserPublicId,
              sessionPublicId: null,
              clientPublicId: row.clientPublicId,
              grantPublicId: row.grantPublicId,
              pairingPublicId: null,
              subjectFingerprint: null,
              metadata: { reason },
            },
          );
          return null;
        }
        if (row.activatedAt === null || (row.grantLifetime !== 1 && row.grantLifetime !== 2)) {
          throw new Error('active grant projection is invalid');
        }
        const [boardRows] = await connection.execute<
          Array<RowDataPacket & { boardPublicId: string }>
        >(
          `
        SELECT board_public_id AS boardPublicId
        FROM mcp_grant_boards
        WHERE grant_id = ?
        ORDER BY board_public_id ASC
      `,
          [row.grantDatabaseId],
        );
        const boardIds: BoardId[] = boardRows.map((boardRow) => {
          const parsed = BoardIdParserV1.parse(boardRow.boardPublicId);
          if (!parsed.ok) throw new Error('grant board binding is invalid');
          return parsed.data.value;
        });
        const scopes = scopeValuesFromMask(row.scopeMask);
        const lifecyclePermissions = lifecycleValuesFromMask(row.lifecycleMask);
        if (
          new Set(boardIds).size !== boardIds.length ||
          (boardIds.length === 0 &&
            (!scopes.includes('board.write') || !lifecyclePermissions.includes('board.create')))
        ) {
          throw new Error('active grant has invalid board bindings');
        }
        return {
          ownerUserDatabaseId: row.ownerUserDatabaseId,
          grantDatabaseId: row.grantDatabaseId,
          credentialDatabaseId: row.credentialDatabaseId,
          clientPublicId: row.clientPublicId,
          grantPublicId: row.grantPublicId,
          sourceFamilyPublicId: row.sourceFamilyPublicId,
          scopeMask: row.scopeMask,
          connectionGrant: {
            grantId: row.grantPublicId as never,
            client: buildPairingClientSummary(
              {
                clientId: row.clientPublicId as never,
                clientName: row.clientName,
                installationId: row.installationId,
              },
              this.crypto,
            ),
            scopes,
            lifecyclePermissions,
            boardIds,
            lifetime: row.grantLifetime === 1 ? 'session' : 'persistent',
            status: 'active',
            activatedAt: iso(row.activatedAt),
            expiresAt: iso(row.grantExpiresAt),
          },
        };
      }),
    );
  }
}

const millis = (value: string): number => {
  const result = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isSafeInteger(result)) throw new Error('database returned an invalid timestamp');
  return result;
};

const iso = (value: string): string => new Date(millis(value)).toISOString();
