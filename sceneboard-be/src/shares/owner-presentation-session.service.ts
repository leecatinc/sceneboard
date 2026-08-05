import { createHash } from 'node:crypto';

import type {
  BoardId,
  RevisionId,
  PublicPresentationSessionListV1,
  PublicPresentationSnapshotV1,
  PublicPresentationUpdateRequestV1,
} from '@sceneboard/board-schema';

import { ShareContractError } from '../common/errors/app-error.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { passwordDatabaseNow } from './password-share.repository.js';
import type {
  PublicPresentationAuthorizationV1,
  PublicPresentationSessionService,
} from './public-presentation-session.service.js';
import type { PublicShareProjectionRepository } from './public-share-projection.repository.js';
import type { ShareRepository } from './share.repository.js';

export type OwnerPresentationContextV1 = Readonly<{
  principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>;
  boardId: BoardId;
  revisionId: RevisionId;
}>;

export class OwnerPresentationSessionService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly shares: ShareRepository,
    private readonly projections: PublicShareProjectionRepository,
    private readonly sessions: PublicPresentationSessionService,
  ) {}

  async authorize(input: OwnerPresentationContextV1): Promise<PublicPresentationAuthorizationV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'share.list',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        const membership = context.membership;
        if (context.access.kind !== 'owner' || membership == null)
          throw new ShareContractError('BOARD_NOT_FOUND');
        const share = await this.shares.readShare(connection, membership.boardPk);
        const revision = await this.projections.readOwnerPageIds({
          connection,
          boardPk: membership.boardPk,
          boardId: input.boardId,
          revisionId: input.revisionId,
        });
        const nowSql = await passwordDatabaseNow(connection);
        const now = parseMysqlTimestampUtc(nowSql);
        const room =
          share?.status === 'active' && share.pinnedRevisionId === input.revisionId
            ? {
                sharePk: share.sharePk,
                boardPk: share.boardPk,
                revisionPk: share.pinnedRevisionPk,
                publicationGeneration: share.publicationGeneration,
                accessGeneration: share.accessGeneration,
              }
            : {
                sharePk: 0n,
                boardPk: membership.boardPk,
                revisionPk: revision.revisionPk,
                publicationGeneration: 1,
                accessGeneration: 1,
              };
        return {
          room,
          actorDigest: createHash('sha256')
            .update(`owner-presentation\u0000${input.principal.userPk.toString()}`, 'utf8')
            .digest(),
          pageIds: revision.pageIds,
          now,
        };
      },
    );
  }

  async list(input: OwnerPresentationContextV1): Promise<PublicPresentationSessionListV1> {
    return this.sessions.listAuthorized(await this.authorize(input));
  }

  async start(
    input: OwnerPresentationContextV1 & { currentPageId: string },
  ): Promise<PublicPresentationSnapshotV1> {
    return this.sessions.startAuthorized(await this.authorize(input), input.currentPageId);
  }

  async get(
    input: OwnerPresentationContextV1 & { sessionId: string },
  ): Promise<PublicPresentationSnapshotV1> {
    return this.sessions.getAuthorized(await this.authorize(input), input.sessionId);
  }

  async update(
    input: OwnerPresentationContextV1 & {
      sessionId: string;
      update: PublicPresentationUpdateRequestV1;
    },
  ): Promise<PublicPresentationSnapshotV1> {
    return this.sessions.updateAuthorized(
      await this.authorize(input),
      input.sessionId,
      input.update,
    );
  }

  async end(
    input: OwnerPresentationContextV1 & { sessionId: string },
  ): Promise<{ sessionId: string; status: 'ended' }> {
    return this.sessions.endAuthorized(await this.authorize(input), input.sessionId);
  }
}
