import {
  RetainedHistoryMetadataParserV1,
  canonicalizeJsonV1,
  type HistoryEntryV1,
  type RetainedHistoryActorLabelV1,
  type RetainedHistoryMetadataV1,
  type RevisionId,
} from '@sceneboard/board-schema';

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

export type HistoryHttpMetadataV1 = HistoryAdapterMetadataV1 | RetainedHistoryMetadataV1;

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

export interface RetainedHistoryMetadataEntrySourceV1 {
  entry: HistoryEntryV1;
  actorLabel: RetainedHistoryActorLabelV1;
  schemaVersion: '1.0.0' | '2.0.0' | '3.0.0';
}

const summaries = {
  'board.create': 'Board created',
  'scene.replace': 'Scene updated',
  'scene.clear': 'Scene cleared',
  'scene.restore': 'Revision restored',
  'document.replace': 'Document updated',
} as const;

const retainedEntry = (
  source: RetainedHistoryMetadataEntrySourceV1,
): RetainedHistoryMetadataV1['entries'][number] => ({
  revisionId: source.entry.revision.revisionId,
  label: `Revision ${source.entry.revision.revisionNumber}`,
  actorLabel: source.actorLabel,
  summary: summaries[source.entry.originType],
  schemaVersion: source.schemaVersion,
});

const assertRetained = (value: unknown): RetainedHistoryMetadataV1 => {
  const parsed = RetainedHistoryMetadataParserV1.parse(value);
  if (!parsed.ok || parsed.data.canonicalBytes.byteLength > 131_072) {
    throw new BoardPersistenceError('row_integrity');
  }
  return parsed.data.value;
};

export const retainedHistoryListMetadata = (
  sources: readonly RetainedHistoryMetadataEntrySourceV1[],
  boundary: RetainedHistoryMetadataV1['boundary'],
): RetainedHistoryMetadataV1 =>
  assertRetained({
    protocolVersion: 1,
    type: 'history.retained-metadata',
    entries: sources.map(retainedEntry),
    boundary,
    navigation: null,
  });

export const retainedHistoryGetMetadata = (input: {
  source: RetainedHistoryMetadataEntrySourceV1;
  boundary: RetainedHistoryMetadataV1['boundary'];
  previous: NonNullable<RetainedHistoryMetadataV1['navigation']>['previous'];
  nextRevisionId: RevisionId | null;
  latestRevisionId: RevisionId;
}): RetainedHistoryMetadataV1 =>
  assertRetained({
    protocolVersion: 1,
    type: 'history.retained-metadata',
    entries: [retainedEntry(input.source)],
    boundary: input.boundary,
    navigation: {
      revisionId: input.source.entry.revision.revisionId,
      previous: input.previous,
      nextRevisionId: input.nextRevisionId,
      latestRevisionId: input.latestRevisionId,
    },
  });
