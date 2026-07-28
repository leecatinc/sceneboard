import { BoardIdParserV1, type BoardId, type RevisionId } from '@sceneboard/board-schema';

import { ShareContractError } from '../common/errors/app-error.js';
import type { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import type { PasswordShareRepository } from './password-share.repository.js';
import { passwordDatabaseNow } from './password-share.repository.js';
import type { ShareCookieService } from './share-cookie.service.js';
import type { ShareRepository } from './share.repository.js';
import type { ShareTokenService } from './share-token.service.js';

export interface PasswordShareViewerGrant {
  kind: 'share_viewer';
  shareId: string;
  boardPk: bigint;
  boardId: BoardId;
  pinnedRevisionPk: bigint;
  pinnedRevisionId: RevisionId;
  publicationGeneration: number;
  accessGeneration: number;
  credentialVersion: number;
  expiresAtSql: string;
}

export class PasswordShareGuard {
  constructor(
    private readonly mysql: MysqlService,
    private readonly shares: ShareRepository,
    private readonly passwords: PasswordShareRepository,
    private readonly tokens: ShareTokenService,
    private readonly cookies: ShareCookieService,
  ) {}

  async resolve(input: {
    shareToken: string;
    familyToken: string;
  }): Promise<PasswordShareViewerGrant> {
    let tokenDigest: Buffer;
    let familyDigest: Buffer;
    try {
      tokenDigest = this.tokens.digest(input.shareToken);
      familyDigest = this.cookies.familyDigest(input.familyToken);
    } catch {
      throw new ShareContractError('BOARD_NOT_FOUND');
    }
    return this.mysql.withConnection((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const share = await this.shares.lockShareByTokenDigest(connection, tokenDigest);
        if (
          share === null ||
          share.status !== 'active' ||
          share.accessPolicy !== 'P' ||
          share.credential === null
        ) {
          throw new ShareContractError('BOARD_NOT_FOUND');
        }
        const nowSql = await passwordDatabaseNow(connection);
        const family = await this.passwords.lockFamily(connection, familyDigest, nowSql);
        const grant = await this.passwords.lockGrant(connection, {
          familyDigest,
          sharePk: share.sharePk,
          nowSql,
        });
        if (
          family === null ||
          grant === null ||
          grant.accessGeneration !== share.accessGeneration ||
          grant.credentialVersion !== share.credential.credentialVersion
        ) {
          throw new ShareContractError('BOARD_NOT_FOUND');
        }
        const [boardRows] = await connection.execute<
          Array<{ boardId: string } & import('mysql2/promise').RowDataPacket>
        >('SELECT public_id AS boardId FROM boards WHERE board_pk = ? AND archived_at IS NULL', [
          share.boardPk.toString(),
        ]);
        if (boardRows.length !== 1) throw new ShareContractError('BOARD_NOT_FOUND');
        const boardId = BoardIdParserV1.parse(boardRows[0]!.boardId);
        if (!boardId.ok) throw new ShareContractError('BOARD_NOT_FOUND');
        return {
          kind: 'share_viewer',
          shareId: share.shareId,
          boardPk: share.boardPk,
          boardId: boardId.data.value,
          pinnedRevisionPk: share.pinnedRevisionPk,
          pinnedRevisionId: share.pinnedRevisionId,
          publicationGeneration: share.publicationGeneration,
          accessGeneration: share.accessGeneration,
          credentialVersion: share.credential.credentialVersion,
          expiresAtSql: grant.expiresAtSql,
        };
      }),
    );
  }
}
