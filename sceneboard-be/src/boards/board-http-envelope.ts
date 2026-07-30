import {
  canonicalizeJsonV1,
  type BoardOperationResultV1,
  type MutationResultV1,
  type MutationResultV2,
  type MutationResultV3,
  type RequestId,
} from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type { HistoryHttpMetadataV1 } from '../history/history-adapter-metadata.js';

export interface BoardHttpSuccessEnvelopeV1 {
  protocolVersion: 1;
  type: 'board.http.success';
  requestId: RequestId;
  result: BoardOperationResultV1 | MutationResultV1 | MutationResultV2 | MutationResultV3;
  metadata: { history: HistoryHttpMetadataV1 | null };
}

export const boardHttpSuccess = (
  result: BoardOperationResultV1 | MutationResultV1 | MutationResultV2 | MutationResultV3,
  history: HistoryHttpMetadataV1 | null = null,
): BoardHttpSuccessEnvelopeV1 => {
  const resultType = result.result.type;
  const isHistory = resultType === 'history.list' || resultType === 'history.get';
  if (isHistory !== (history !== null)) throw new BoardPersistenceError('row_integrity');
  if (history !== null) {
    if (result.type !== 'board.operation.result') throw new BoardPersistenceError('row_integrity');
    if (resultType === 'history.list') {
      const ids = result.result.entries.map(
        (entry: { revision: { revisionId: string } }) => entry.revision.revisionId,
      );
      if (
        history.navigation !== null ||
        JSON.stringify(ids) !== JSON.stringify(history.entries.map((entry) => entry.revisionId))
      ) {
        throw new BoardPersistenceError('row_integrity');
      }
    } else if (resultType === 'history.get') {
      const revisionId = result.result.entry.revision.revisionId;
      if (
        history.entries.length !== 1 ||
        history.entries[0]?.revisionId !== revisionId ||
        history.navigation?.revisionId !== revisionId
      ) {
        throw new BoardPersistenceError('row_integrity');
      }
    }
    const canonicalMetadata = canonicalizeJsonV1(history);
    if (!canonicalMetadata.ok || canonicalMetadata.data.canonicalBytes.byteLength > 131_072) {
      throw new BoardPersistenceError('row_integrity');
    }
  }
  return {
    protocolVersion: 1,
    type: 'board.http.success',
    requestId: result.requestId,
    result,
    metadata: { history },
  };
};
