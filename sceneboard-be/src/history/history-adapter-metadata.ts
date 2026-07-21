import { canonicalizeJsonV1, type HistoryEntryV1, type RevisionId } from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';

export interface HistoryAdapterMetadataV1 {
  protocolVersion: 1;
  type: 'history.adapter-metadata';
  entries: Array<{ revisionId: RevisionId; label: string }>;
  navigation: null | {
    revisionId: RevisionId;
    previousRevisionId: RevisionId | null;
    nextRevisionId: RevisionId | null;
    latestRevisionId: RevisionId;
  };
}

const validLabel = (label: string): boolean => {
  const scalars = Array.from(label).length;
  return scalars >= 1 && scalars <= 200 && !/[\uD800-\uDFFF]/u.test(label);
};

const assertBounded = (metadata: HistoryAdapterMetadataV1): HistoryAdapterMetadataV1 => {
  if (metadata.entries.some((entry) => !validLabel(entry.label))) {
    throw new BoardPersistenceError('row_integrity');
  }
  const canonical = canonicalizeJsonV1(metadata);
  if (!canonical.ok || canonical.data.canonicalBytes.byteLength > 131_072) {
    throw new BoardPersistenceError('row_integrity');
  }
  return metadata;
};

export const historyListMetadata = (
  entries: readonly HistoryEntryV1[],
  labels: readonly string[],
): HistoryAdapterMetadataV1 => {
  if (entries.length !== labels.length) throw new BoardPersistenceError('row_integrity');
  return assertBounded({
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries: entries.map((entry, index) => ({
      revisionId: entry.revision.revisionId,
      label: labels[index] ?? '',
    })),
    navigation: null,
  });
};

export const historyGetMetadata = (input: {
  entry: HistoryEntryV1;
  label: string;
  nextRevisionId: RevisionId | null;
  latestRevisionId: RevisionId;
}): HistoryAdapterMetadataV1 =>
  assertBounded({
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries: [{ revisionId: input.entry.revision.revisionId, label: input.label }],
    navigation: {
      revisionId: input.entry.revision.revisionId,
      previousRevisionId: input.entry.previousRevisionId,
      nextRevisionId: input.nextRevisionId,
      latestRevisionId: input.latestRevisionId,
    },
  });
