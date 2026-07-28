import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';

export class MediaRetentionService {
  async reconcileRetentionItem(
    connection: PoolConnection,
    input: { boardPk: string; revisionPk: string; runId: string; fence: bigint },
  ): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `
      SELECT ordinal
      FROM board_revision_media_refs
      WHERE board_pk = ? AND revision_pk = ?
      ORDER BY ordinal ASC
      FOR UPDATE
    `,
      [input.boardPk, input.revisionPk],
    );
    if (rows.length === 0) return;
    const [holds] = await connection.execute<RowDataPacket[]>(
      `
      SELECT kind, holder_id
      FROM board_revision_holds
      WHERE board_pk = ? AND revision_pk = ?
        AND released_at IS NULL
        AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
      ORDER BY kind ASC, holder_id ASC
      FOR UPDATE
    `,
      [input.boardPk, input.revisionPk],
    );
    if (holds.length !== 0) throw new BoardPersistenceError('row_integrity');
    if (input.runId.length === 0 || input.fence < 1n || input.fence > 9_007_199_254_740_991n)
      throw new BoardPersistenceError('row_integrity');
  }

  async applyPublicationTransition(
    connection: PoolConnection,
    input: {
      sharePk: bigint;
      oldRevisionPk: bigint | null;
      newRevisionPk: bigint | null;
      publicationGeneration: number;
      recoveryId: string;
    },
  ): Promise<void> {
    const revisions = [...new Set([input.oldRevisionPk, input.newRevisionPk].filter(Boolean))]
      .map((revisionPk) => revisionPk as bigint)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const revisionPk of revisions) {
      await connection.execute<RowDataPacket[]>(
        `
        SELECT ref.media_id
        FROM board_revision_media_refs ref
        JOIN board_shares share ON share.share_pk = ?
        WHERE ref.board_pk = share.board_pk AND ref.revision_pk = ?
        ORDER BY ref.ordinal ASC
        FOR UPDATE
      `,
        [input.sharePk.toString(), revisionPk.toString()],
      );
    }
    if (
      input.publicationGeneration < 1 ||
      !Number.isSafeInteger(input.publicationGeneration) ||
      input.recoveryId.length === 0
    )
      throw new BoardPersistenceError('row_integrity');
  }
}
