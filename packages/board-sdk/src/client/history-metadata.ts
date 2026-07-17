import type {
  HistoryEntryV1,
  RevisionId,
} from '@leecat-board/board-schema';

import type { HistoryAdapterMetadataV1 } from '../http/index.js';

export type CorrelatedHistoryListV1 = Array<{
  entry: HistoryEntryV1;
  label: string;
}>;

export const correlateHistoryListV1 = (
  entries: readonly HistoryEntryV1[],
  metadata: HistoryAdapterMetadataV1,
): CorrelatedHistoryListV1 => {
  if (metadata.navigation !== null || entries.length !== metadata.entries.length) {
    throw new TypeError('history list metadata does not correlate');
  }
  return entries.map((entry, index) => {
    const adapter = metadata.entries[index];
    if (adapter === undefined || adapter.revisionId !== entry.revision.revisionId) {
      throw new TypeError('history list metadata order does not correlate');
    }
    return { entry, label: adapter.label };
  });
};

export type CorrelatedHistoryNavigationV1 = {
  revisionId: RevisionId;
  previousRevisionId: RevisionId | null;
  nextRevisionId: RevisionId | null;
  latestRevisionId: RevisionId;
  label: string;
};

export const correlateHistoryNavigationV1 = (
  entry: HistoryEntryV1,
  metadata: HistoryAdapterMetadataV1,
): CorrelatedHistoryNavigationV1 => {
  const revisionId = entry.revision.revisionId;
  const adapter = metadata.entries[0];
  const navigation = metadata.navigation;
  if (metadata.entries.length !== 1 || adapter?.revisionId !== revisionId || navigation?.revisionId !== revisionId) {
    throw new TypeError('history navigation metadata does not correlate');
  }
  return { ...navigation, label: adapter.label };
};
