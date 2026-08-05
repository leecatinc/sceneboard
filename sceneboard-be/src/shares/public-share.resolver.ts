import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  PublicShareTokenParserV1,
  ShortTextParserV1,
  type BoardId,
  type ShortText,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { ShareContractError } from '../common/errors/app-error.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import {
  PasswordShareRepository,
  passwordDatabaseNow,
  type PasswordGrantState,
} from './password-share.repository.js';
import type { ShareCookieService, ShareFamilyCookieInspection } from './share-cookie.service.js';
import { PublicShareHttpError } from './public-share.error.js';
import type { LockedShare, ShareRepository } from './share.repository.js';
import type { PublicShareReference, ShareTokenService } from './share-token.service.js';
import type { StoredPublicContext } from './public-context.store.js';

interface BoardRow extends RowDataPacket {
  boardId: string;
  title: string;
}

export interface ResolvedPublicShare {
  connection: PoolConnection;
  share: LockedShare;
  boardId: BoardId;
  title: ShortText;
  nowSql: string;
  now: Date;
}

export type InitialPublicResolution<Value> =
  | {
      kind: 'password-required';
      clearInvalidFamily: boolean;
      now: Date;
    }
  | { kind: 'ready'; value: Value };

const validGrant = (grant: PasswordGrantState, share: LockedShare, now: Date): boolean =>
  share.credential !== null &&
  grant.accessGeneration === share.accessGeneration &&
  grant.credentialVersion === share.credential.credentialVersion &&
  parseMysqlTimestampUtc(grant.expiresAtSql).valueOf() > now.valueOf();

export class PublicShareResolver {
  constructor(
    private readonly mysql: MysqlService,
    private readonly shares: ShareRepository,
    private readonly passwords: PasswordShareRepository,
    private readonly tokens: ShareTokenService,
    private readonly shareCookies: ShareCookieService,
  ) {}

  async withInitial<Value>(input: {
    shareToken: string;
    shareFamily: ShareFamilyCookieInspection;
    operation: (resolved: ResolvedPublicShare) => Promise<Value>;
  }): Promise<InitialPublicResolution<Value>> {
    const parsedToken = PublicShareTokenParserV1.parse(input.shareToken);
    if (!parsedToken.ok) throw new PublicShareHttpError(404);
    let reference: PublicShareReference;
    try {
      reference = this.tokens.publicReference(parsedToken.data.value);
    } catch {
      throw new PublicShareHttpError(404);
    }
    return this.withStore((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const observed = await this.readReferencedShare(connection, reference);
        if (observed === null) throw new PublicShareHttpError(404);
        const board = await this.lockBoard(connection, observed.boardPk);
        const share = await this.lockReferencedShare(connection, reference);
        if (
          share === null ||
          share.boardPk !== observed.boardPk ||
          share.status !== 'active' ||
          !this.matchesReference(share, reference)
        )
          throw new PublicShareHttpError(404);
        const nowSql = await passwordDatabaseNow(connection);
        const now = parseMysqlTimestampUtc(nowSql);
        if (share.accessPolicy === 'P') {
          if (share.credential === null) throw new PublicShareHttpError(503);
          const passwordState = await this.resolvePasswordGrant(
            connection,
            share,
            input.shareFamily,
            nowSql,
            now,
          );
          if (passwordState !== 'current')
            return {
              kind: 'password-required',
              clearInvalidFamily: passwordState === 'invalid-family',
              now,
            };
        } else if (share.credential !== null) {
          throw new PublicShareHttpError(503);
        }
        return {
          kind: 'ready',
          value: await input.operation({
            connection,
            share,
            ...board,
            nowSql,
            now,
          }),
        };
      }),
    );
  }

  private readReferencedShare(
    connection: PoolConnection,
    reference: PublicShareReference,
  ): Promise<LockedShare | null> {
    return reference.kind === 'secret'
      ? this.shares.readShareByTokenDigest(connection, reference.digest)
      : this.shares.readShareById(connection, reference.shareId);
  }

  private lockReferencedShare(
    connection: PoolConnection,
    reference: PublicShareReference,
  ): Promise<LockedShare | null> {
    return reference.kind === 'secret'
      ? this.shares.lockShareByTokenDigest(connection, reference.digest)
      : this.shares.lockShareById(connection, reference.shareId);
  }

  private matchesReference(share: LockedShare, reference: PublicShareReference): boolean {
    return reference.kind === 'secret'
      ? share.tokenDigest.equals(reference.digest)
      : share.shareId === reference.shareId &&
          share.accessGeneration === reference.accessGeneration;
  }

  async withContext<Value>(input: {
    context: StoredPublicContext;
    shareFamily: ShareFamilyCookieInspection;
    operation: (resolved: ResolvedPublicShare) => Promise<Value>;
  }): Promise<Value> {
    return this.withStore((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const board = await this.lockBoard(connection, input.context.boardPk);
        const share = await this.shares.lockShareByPk(connection, input.context.sharePk);
        if (
          share === null ||
          share.boardPk !== input.context.boardPk ||
          share.pinnedRevisionPk !== input.context.revisionPk ||
          share.status !== 'active' ||
          share.publicationGeneration !== input.context.publicationGeneration ||
          share.accessGeneration !== input.context.accessGeneration
        )
          throw new PublicShareHttpError(404);
        const nowSql = await passwordDatabaseNow(connection);
        const now = parseMysqlTimestampUtc(nowSql);
        const contextValidUntil = new Date(input.context.validUntil).valueOf();
        const contextFamilyExpiresAt = new Date(input.context.familyExpiresAt).valueOf();
        if (
          !Number.isFinite(contextValidUntil) ||
          !Number.isFinite(contextFamilyExpiresAt) ||
          now.valueOf() >= contextValidUntil ||
          now.valueOf() >= contextFamilyExpiresAt
        )
          throw new PublicShareHttpError(404);
        if (share.accessPolicy === 'P') {
          if (share.credential === null) throw new PublicShareHttpError(503);
          const state = await this.resolvePasswordGrant(
            connection,
            share,
            input.shareFamily,
            nowSql,
            now,
          );
          if (state !== 'current') throw new PublicShareHttpError(404);
        } else if (share.credential !== null) {
          throw new PublicShareHttpError(503);
        }
        return input.operation({ connection, share, ...board, nowSql, now });
      }),
    );
  }

  async withPublicShareId<Value>(input: {
    shareId: string;
    shareFamily: ShareFamilyCookieInspection;
    operation: (resolved: ResolvedPublicShare) => Promise<Value>;
  }): Promise<Value> {
    const parsedShareId = GlobalIdStringParserV1.parse(input.shareId);
    if (!parsedShareId.ok) throw new PublicShareHttpError(404);
    return this.withStore((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const observed = await this.shares.readShareById(connection, parsedShareId.data.value);
        if (observed === null) throw new PublicShareHttpError(404);
        const board = await this.lockBoard(connection, observed.boardPk);
        const share = await this.shares.lockShareById(connection, parsedShareId.data.value);
        if (share === null || share.boardPk !== observed.boardPk || share.status !== 'active')
          throw new PublicShareHttpError(404);
        const nowSql = await passwordDatabaseNow(connection);
        const now = parseMysqlTimestampUtc(nowSql);
        if (share.accessPolicy === 'P') {
          if (share.credential === null) throw new PublicShareHttpError(503);
          const state = await this.resolvePasswordGrant(
            connection,
            share,
            input.shareFamily,
            nowSql,
            now,
          );
          if (state !== 'current') throw new PublicShareHttpError(404);
        } else if (share.credential !== null) {
          throw new PublicShareHttpError(503);
        }
        return input.operation({ connection, share, ...board, nowSql, now });
      }),
    );
  }

  private async resolvePasswordGrant(
    connection: PoolConnection,
    share: LockedShare,
    inspection: ShareFamilyCookieInspection,
    nowSql: string,
    now: Date,
  ): Promise<'current' | 'no-grant' | 'invalid-family'> {
    if (inspection.kind === 'absent') return 'no-grant';
    if (inspection.kind === 'invalid') return 'invalid-family';
    const family = await this.passwords.lockFamily(connection, inspection.digest, nowSql);
    if (family === null) return 'invalid-family';
    const grant = await this.passwords.lockGrantState(connection, {
      familyDigest: inspection.digest,
      sharePk: share.sharePk,
    });
    if (grant === null) return 'no-grant';
    if (!validGrant(grant, share, now)) throw new PublicShareHttpError(404);
    return 'current';
  }

  private async lockBoard(
    connection: PoolConnection,
    boardPk: bigint,
  ): Promise<{ boardId: BoardId; title: ShortText }> {
    const [rows] = await connection.execute<BoardRow[]>(
      `SELECT public_id AS boardId, title
       FROM boards
       WHERE board_pk = ? AND archived_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [boardPk.toString()],
    );
    const row = rows[0];
    if (rows.length === 0 || row === undefined) throw new PublicShareHttpError(404);
    if (rows.length !== 1) throw new PublicShareHttpError(503);
    const boardId = BoardIdParserV1.parse(row.boardId);
    const title = ShortTextParserV1.parse(row.title);
    if (!boardId.ok || !title.ok) throw new PublicShareHttpError(503);
    return { boardId: boardId.data.value, title: title.data.value };
  }

  private async withStore<Value>(
    operation: (connection: PoolConnection) => Promise<Value>,
  ): Promise<Value> {
    try {
      return await this.mysql.withConnection(operation);
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      if (error instanceof ShareContractError && error.code === 'BOARD_NOT_FOUND')
        throw new PublicShareHttpError(404);
      throw new PublicShareHttpError(503);
    }
  }
}
