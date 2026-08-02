import type { AccountApiKeyScopeV1 } from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import {
  accountApiKeyAuthenticationAudit,
  accountApiKeyIssuedAudit,
  accountApiKeyListedAudit,
  accountApiKeyRevokedAudit,
  type AccountApiKeyAuditContext,
} from './account-api-key-audit.policy.js';
import { accountApiKeyScopesFromMask } from './account-api-key.scope.js';

export type AccountApiKeyStatus = 'active' | 'expired' | 'revoked';

export interface AccountApiKeyMetadata {
  apiKeyId: string;
  name: string;
  prefix: string;
  scopes: readonly AccountApiKeyScopeV1[];
  status: AccountApiKeyStatus;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface AccountApiKeyListBoundary {
  createdAt: string;
  id: string;
}

export interface AccountApiKeyCredentialRecord {
  keyPk: string;
  keyPublicId: string;
  ownerUserPk: string;
  ownerPublicId: string;
  ownerStatus: number;
  tokenHash: Buffer;
  scopeMask: number;
  persistedStatus: number;
  expiresAt: number;
  databaseNow: number;
}

export interface ActiveAccountApiKeySnapshot {
  keyPk: string;
  keyPublicId: string;
  ownerUserPk: string;
  ownerPublicId: string;
  scopeMask: number;
  scopes: readonly AccountApiKeyScopeV1[];
  expiresAt: number;
}

interface OwnerRow extends RowDataPacket {
  status: number;
  publicId: string;
}

interface DatabaseClockRow extends RowDataPacket {
  databaseNow: string;
}

interface ActiveQuotaRow extends RowDataPacket {
  activeCount: number;
  earliestActiveExpiry: string | null;
}

interface MetadataRow extends RowDataPacket {
  id: string;
  publicId: string;
  displayName: string;
  tokenLocator: Buffer;
  scopeMask: number;
  status: number;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  databaseNow: string;
}

interface CredentialRow extends RowDataPacket {
  keyPk: string;
  keyPublicId: string;
  ownerUserPk: string;
  ownerPublicId: string;
  ownerStatus: number;
  tokenHash: Buffer;
  scopeMask: number;
  persistedStatus: number;
  expiresAt: string;
  databaseNow: string;
}

interface ActiveRecheckRow extends RowDataPacket {
  keyPublicId: string;
  ownerUserPk: string;
  ownerPublicId: string;
  ownerStatus: number;
  scopeMask: number;
  persistedStatus: number;
  expiresAt: string;
}

export type AccountApiKeyIssuePersistenceResult =
  | { kind: 'created'; metadata: AccountApiKeyMetadata }
  | { kind: 'owner_disabled' }
  | { kind: 'invalid_expiry' }
  | { kind: 'quota_exceeded'; earliestActiveExpiry: number; databaseNow: number }
  | { kind: 'collision' };

const DAY_MS = 24 * 60 * 60 * 1_000;

export type AccountApiKeyListPersistenceResult =
  | {
      kind: 'listed';
      items: AccountApiKeyMetadata[];
      nextBoundary: AccountApiKeyListBoundary | null;
    }
  | { kind: 'owner_disabled' };

export type AccountApiKeyRevokePersistenceResult =
  | { kind: 'revoked' | 'already_revoked' | 'not_found' }
  | { kind: 'owner_disabled' };

const mysqlDate = (value: number): string =>
  new Date(value).toISOString().slice(0, 23).replace('T', ' ');

const millis = (value: string): number => Date.parse(value.replace(' ', 'T') + 'Z');

const iso = (value: string): string => new Date(millis(value)).toISOString();

const metadataFromRow = (row: MetadataRow, now: number, prefix: string): AccountApiKeyMetadata => ({
  apiKeyId: row.publicId,
  name: row.displayName,
  prefix,
  scopes: accountApiKeyScopesFromMask(Number(row.scopeMask)),
  status: row.status === 2 ? 'revoked' : millis(row.expiresAt) <= now ? 'expired' : 'active',
  createdAt: iso(row.createdAt),
  expiresAt: iso(row.expiresAt),
  lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
});

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY';

export class AccountApiKeyRepository {
  constructor(
    private readonly mysql: MysqlService,
    private readonly audit: AuditRepository,
  ) {}

  async issue(input: {
    ownerUserPk: string;
    keyPublicId: string;
    name: string;
    locator: Buffer;
    tokenHash: Buffer;
    scopeMask: number;
    expiresInDays: number;
    prefix: string;
    auditContext: AccountApiKeyAuditContext;
  }): Promise<AccountApiKeyIssuePersistenceResult> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const owner = await this.lockOwner(connection, input.ownerUserPk);
          if (owner === null || owner.status !== 1) return { kind: 'owner_disabled' as const };
          const databaseNow = await this.databaseNow(connection);
          const databaseNowMs = millis(databaseNow);
          if (
            !Number.isSafeInteger(input.expiresInDays) ||
            ![30, 90, 365].includes(input.expiresInDays)
          ) {
            return { kind: 'invalid_expiry' as const };
          }
          const expiresAt = databaseNowMs + input.expiresInDays * DAY_MS;
          const [counts] = await connection.execute<ActiveQuotaRow[]>(
            `SELECT
               COUNT(*) AS activeCount,
               MIN(expires_at) AS earliestActiveExpiry
             FROM account_api_keys
             WHERE owner_user_id = ? AND status = 1 AND expires_at > ?`,
            [input.ownerUserPk, databaseNow],
          );
          const quota = counts[0];
          if (Number(quota?.activeCount ?? 0) >= 10) {
            if (quota?.earliestActiveExpiry === null || quota?.earliestActiveExpiry === undefined) {
              throw new Error('active API-key quota expiry missing');
            }
            return {
              kind: 'quota_exceeded' as const,
              earliestActiveExpiry: parseMysqlTimestampUtc(quota.earliestActiveExpiry).valueOf(),
              databaseNow: databaseNowMs,
            };
          }
          let inserted: ResultSetHeader;
          try {
            [inserted] = await connection.execute<ResultSetHeader>(
              `INSERT INTO account_api_keys (
                 public_id, owner_user_id, display_name, token_version, token_locator,
                 token_hash, scope_mask, status, expires_at, created_at
               ) VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
              [
                input.keyPublicId,
                input.ownerUserPk,
                input.name,
                input.locator,
                input.tokenHash,
                input.scopeMask,
                mysqlDate(expiresAt),
                databaseNow,
              ],
            );
          } catch (error) {
            if (isDuplicateKey(error)) return { kind: 'collision' as const };
            throw error;
          }
          await this.audit.writeMandatory(
            { connection },
            accountApiKeyIssuedAudit(input.auditContext, input.keyPublicId),
          );
          const metadata: AccountApiKeyMetadata = {
            apiKeyId: input.keyPublicId,
            name: input.name,
            prefix: input.prefix,
            scopes: accountApiKeyScopesFromMask(input.scopeMask),
            status: 'active',
            createdAt: iso(databaseNow),
            expiresAt: new Date(expiresAt).toISOString(),
            lastUsedAt: null,
          };
          if (inserted.affectedRows !== 1) throw new Error('account API-key insert failed');
          return { kind: 'created' as const, metadata };
        }),
      );
    } catch (error) {
      if (isDuplicateKey(error)) return { kind: 'collision' };
      throw error;
    }
  }

  async list(input: {
    ownerUserPk: string;
    boundary: AccountApiKeyListBoundary | null;
    limit: number;
    prefixFromLocator: (locator: Uint8Array) => string;
    auditContext: AccountApiKeyAuditContext;
  }): Promise<AccountApiKeyListPersistenceResult> {
    return this.mysql.withConnection((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const owner = await this.lockOwner(connection, input.ownerUserPk);
        if (owner === null || owner.status !== 1) return { kind: 'owner_disabled' as const };
        const cursorClause =
          input.boundary === null ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))';
        const cursorValues =
          input.boundary === null
            ? []
            : [
                mysqlDate(Date.parse(input.boundary.createdAt)),
                mysqlDate(Date.parse(input.boundary.createdAt)),
                input.boundary.id,
              ];
        const [rows] = await connection.execute<MetadataRow[]>(
          `SELECT
             CAST(id AS CHAR) AS id,
             public_id AS publicId,
             display_name AS displayName,
             token_locator AS tokenLocator,
             scope_mask AS scopeMask,
             status,
             expires_at AS expiresAt,
             created_at AS createdAt,
             last_used_at AS lastUsedAt,
             CURRENT_TIMESTAMP(3) AS databaseNow
           FROM account_api_keys
           WHERE owner_user_id = ?${cursorClause}
           ORDER BY created_at DESC, id DESC
           LIMIT ${input.limit + 1}`,
          [input.ownerUserPk, ...cursorValues],
        );
        const hasNext = rows.length > input.limit;
        const emitted = rows.slice(0, input.limit);
        const items = emitted.map((row) =>
          metadataFromRow(row, millis(row.databaseNow), input.prefixFromLocator(row.tokenLocator)),
        );
        await this.audit.writeMandatory(
          { connection },
          accountApiKeyListedAudit(input.auditContext, items.length),
        );
        const last = emitted.at(-1);
        return {
          kind: 'listed' as const,
          items,
          nextBoundary:
            hasNext && last !== undefined ? { createdAt: iso(last.createdAt), id: last.id } : null,
        };
      }),
    );
  }

  async revoke(input: {
    ownerUserPk: string;
    keyPublicId: string;
    auditContext: AccountApiKeyAuditContext;
  }): Promise<AccountApiKeyRevokePersistenceResult> {
    return this.mysql.withConnection((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const owner = await this.lockOwner(connection, input.ownerUserPk);
        if (owner === null || owner.status !== 1) return { kind: 'owner_disabled' as const };
        const [rows] = await connection.execute<
          Array<RowDataPacket & { id: string; status: number; databaseNow: string }>
        >(
          `SELECT CAST(id AS CHAR) AS id, status, UTC_TIMESTAMP(3) AS databaseNow
           FROM account_api_keys
           WHERE owner_user_id = ? AND public_id = ?
           FOR UPDATE`,
          [input.ownerUserPk, input.keyPublicId],
        );
        const row = rows[0];
        const kind =
          row === undefined ? 'not_found' : row.status === 2 ? 'already_revoked' : 'revoked';
        if (row !== undefined && row.status === 1) {
          const [updated] = await connection.execute<ResultSetHeader>(
            `UPDATE account_api_keys
             SET status = 2, revoked_at = GREATEST(?, created_at)
             WHERE id = ? AND status = 1`,
            [row.databaseNow, row.id],
          );
          if (updated.affectedRows !== 1) throw new Error('account API-key revoke failed');
        }
        await this.audit.writeMandatory(
          { connection },
          accountApiKeyRevokedAudit(
            input.auditContext,
            input.keyPublicId,
            kind === 'revoked' ? 'owner' : kind,
          ),
        );
        return { kind };
      }),
    );
  }

  async findCredential(locator: Buffer): Promise<AccountApiKeyCredentialRecord | null> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.execute<CredentialRow[]>(
        `SELECT
           CAST(k.id AS CHAR) AS keyPk,
           k.public_id AS keyPublicId,
           CAST(u.id AS CHAR) AS ownerUserPk,
           u.public_id AS ownerPublicId,
           u.status AS ownerStatus,
           k.token_hash AS tokenHash,
           k.scope_mask AS scopeMask,
           k.status AS persistedStatus,
           k.expires_at AS expiresAt,
           UTC_TIMESTAMP(3) AS databaseNow
         FROM account_api_keys k
         JOIN users u ON u.id = k.owner_user_id
         WHERE k.token_locator = ?`,
        [locator],
      );
      const row = rows[0];
      if (row === undefined) return null;
      let expiresAt: number;
      let databaseNow: number;
      try {
        expiresAt = parseMysqlTimestampUtc(row.expiresAt).valueOf();
        databaseNow = parseMysqlTimestampUtc(row.databaseNow).valueOf();
      } catch {
        return null;
      }
      return {
        ...row,
        tokenHash: Buffer.from(row.tokenHash),
        scopeMask: Number(row.scopeMask),
        ownerStatus: Number(row.ownerStatus),
        persistedStatus: Number(row.persistedStatus),
        expiresAt,
        databaseNow,
      };
    });
  }

  async writeAuthenticationAudit(input: {
    context: AccountApiKeyAuditContext;
    result:
      | { succeeded: true; keyPublicId: string }
      | {
          succeeded: false;
          keyPublicId: string | null;
          reason: 'malformed' | 'unknown' | 'invalid' | 'expired' | 'revoked' | 'owner_disabled';
          subjectFingerprint: Buffer | null;
        };
  }): Promise<void> {
    await this.mysql.withConnection((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        await this.audit.writeMandatory(
          { connection },
          accountApiKeyAuthenticationAudit(input.context, input.result),
        );
      }),
    );
  }

  async recheckActive(
    connection: PoolConnection,
    snapshot: ActiveAccountApiKeySnapshot,
  ): Promise<boolean> {
    const [rows] = await connection.execute<ActiveRecheckRow[]>(
      `SELECT
         k.public_id AS keyPublicId,
         CAST(u.id AS CHAR) AS ownerUserPk,
         u.public_id AS ownerPublicId,
         u.status AS ownerStatus,
         k.scope_mask AS scopeMask,
         k.status AS persistedStatus,
         k.expires_at AS expiresAt
       FROM account_api_keys k
       JOIN users u ON u.id = k.owner_user_id
       WHERE k.id = ?
         AND k.expires_at > UTC_TIMESTAMP(3)
       FOR UPDATE`,
      [snapshot.keyPk],
    );
    const row = rows[0];
    return (
      row !== undefined &&
      row.keyPublicId === snapshot.keyPublicId &&
      row.ownerUserPk === snapshot.ownerUserPk &&
      row.ownerPublicId === snapshot.ownerPublicId &&
      Number(row.ownerStatus) === 1 &&
      Number(row.persistedStatus) === 1 &&
      Number(row.scopeMask) === snapshot.scopeMask
    );
  }

  async markUsed(keyPk: string): Promise<void> {
    await this.mysql.withConnection(async (connection) => {
      await connection.execute(
        `UPDATE account_api_keys
         SET last_used_at = GREATEST(UTC_TIMESTAMP(3), created_at)
         WHERE id = ?
           AND status = 1
           AND (last_used_at IS NULL OR last_used_at < UTC_TIMESTAMP(3) - INTERVAL 60 SECOND)`,
        [keyPk],
      );
    });
  }

  private async lockOwner(
    connection: PoolConnection,
    ownerUserPk: string,
  ): Promise<OwnerRow | null> {
    const [rows] = await connection.execute<OwnerRow[]>(
      `SELECT status, public_id AS publicId
       FROM users
       WHERE id = ?
       FOR UPDATE`,
      [ownerUserPk],
    );
    return rows[0] ?? null;
  }

  private async databaseNow(connection: PoolConnection): Promise<string> {
    const [rows] = await connection.execute<DatabaseClockRow[]>(
      'SELECT UTC_TIMESTAMP(3) AS databaseNow',
    );
    const databaseNow = rows[0]?.databaseNow;
    if (databaseNow === undefined) throw new Error('database clock read failed');
    return databaseNow;
  }
}
