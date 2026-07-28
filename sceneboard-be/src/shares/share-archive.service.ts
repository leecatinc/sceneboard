import type { PoolConnection } from 'mysql2/promise';

import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';
import { shareStateDigest, type ShareRepository } from './share.repository.js';
import type { ShareTransitionRecoveryService } from './share-transition-recovery.service.js';

export class ShareArchiveService {
  constructor(
    private readonly shares: ShareRepository,
    private readonly recovery: ShareTransitionRecoveryService,
  ) {}

  async archiveWithinBoardTransaction(
    connection: PoolConnection,
    input: {
      context: AuthorizedBoardContextV1;
      boardPk: bigint;
      fingerprintSha256: Buffer;
      nowSql: string;
      userPublicId: string | null;
      sessionPublicId: string | null;
    },
  ): Promise<void> {
    const share = await this.shares.lockShare(connection, input.boardPk);
    if (share === null || share.status === 'archived') return;
    const recoveryId = this.shares.newRecoveryId();
    const leaseOwner = `${input.context.actor.principalId}:${recoveryId}`;
    const accessGeneration =
      share.status === 'active'
        ? this.shares.nextGeneration(share.accessGeneration)
        : share.accessGeneration;
    const version = this.shares.nextGeneration(share.version);
    await this.recovery.plan(connection, {
      recoveryId,
      boardPk: input.boardPk,
      sharePk: share.sharePk,
      operation: 'archive',
      fingerprintSha256: input.fingerprintSha256,
      beforeSha256: shareStateDigest(share),
      afterSha256: shareStateDigest({
        shareId: share.shareId,
        boardPk: share.boardPk,
        status: 'archived',
        accessPolicy: 'L',
        pinnedRevisionPk: share.pinnedRevisionPk,
        publicationGeneration: share.publicationGeneration,
        accessGeneration,
        tokenDigest: share.tokenDigest,
        version,
        credential: null,
      }),
      oldRevisionPk: share.pinnedRevisionPk,
      newRevisionPk: share.pinnedRevisionPk,
      leaseOwner,
      nowSql: input.nowSql,
      credentialMarker: null,
    });
    const archived = await this.shares.archive(connection, share, input.nowSql);
    if (share.status === 'active') {
      await this.shares.releaseHold(connection, {
        boardPk: share.boardPk,
        revisionPk: share.pinnedRevisionPk,
        kind: 'published',
        holderId: this.shares.publicationHolder(share.shareId, share.publicationGeneration),
        nowSql: input.nowSql,
      });
    }
    await this.shares.writeAudit(connection, {
      event: 'share.archived',
      actorPublicId: input.context.actor.principalId,
      userPublicId: input.userPublicId,
      sessionPublicId: input.sessionPublicId,
      metadata: {
        boardPk: share.boardPk.toString(),
        sharePk: share.sharePk.toString(),
        publicationGeneration: archived.publicationGeneration,
        accessGeneration: archived.accessGeneration,
        recoveryId,
      },
    });
    await this.recovery.markCoreApplied(connection, {
      recoveryId,
      sharePk: archived.sharePk,
      leaseOwner,
      nowSql: input.nowSql,
    });
    await this.recovery.complete(connection, {
      recoveryId,
      share: archived,
      leaseOwner,
      nowSql: input.nowSql,
    });
  }
}
