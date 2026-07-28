import type {
  HistoryEntryV1,
  RetainedHistoryActorLabelV1,
  RevisionId,
} from '@sceneboard/board-schema';

import type { HistoryHttpMetadataV1 } from '../http/index.js';

export type CorrelatedHistoryListV1 = Array<{
  entry: HistoryEntryV1;
  label: string;
  actorLabel?: RetainedHistoryActorLabelV1;
  summary?: string;
  schemaVersion?: '1.0.0' | '2.0.0';
}>;

export const correlateHistoryListV1 = (
  entries: readonly HistoryEntryV1[],
  metadata: HistoryHttpMetadataV1,
): CorrelatedHistoryListV1 => {
  if (metadata.navigation !== null || entries.length !== metadata.entries.length) {
    throw new TypeError('history list metadata does not correlate');
  }
  return entries.map((entry, index) => {
    const adapter = metadata.entries[index];
    if (adapter === undefined || adapter.revisionId !== entry.revision.revisionId) {
      throw new TypeError('history list metadata order does not correlate');
    }
    if (metadata.type === 'history.retained-metadata') {
      const retainedAdapter = metadata.entries[index];
      if (retainedAdapter === undefined) throw new TypeError('history metadata disappeared');
      return {
        entry,
        label: retainedAdapter.label,
        actorLabel: retainedAdapter.actorLabel,
        summary: retainedAdapter.summary,
        schemaVersion: retainedAdapter.schemaVersion,
      };
    }
    return { entry, label: adapter.label };
  });
};

export type CorrelatedHistoryNavigationV1 = {
  revisionId: RevisionId;
  previous?: { kind: 'revision'; revisionId: RevisionId } | { kind: 'truncated' } | null;
  previousRevisionId: RevisionId | null;
  nextRevisionId: RevisionId | null;
  latestRevisionId: RevisionId;
  label: string;
  actorLabel?: RetainedHistoryActorLabelV1;
  summary?: string;
  schemaVersion?: '1.0.0' | '2.0.0';
};

export const correlateHistoryNavigationV1 = (
  entry: HistoryEntryV1,
  metadata: HistoryHttpMetadataV1,
): CorrelatedHistoryNavigationV1 => {
  const revisionId = entry.revision.revisionId;
  const adapter = metadata.entries[0];
  const navigation = metadata.navigation;
  if (
    metadata.entries.length !== 1 ||
    adapter?.revisionId !== revisionId ||
    navigation?.revisionId !== revisionId
  ) {
    throw new TypeError('history navigation metadata does not correlate');
  }
  const previous =
    'previous' in navigation
      ? navigation.previous
      : navigation.previousRevisionId === null
        ? null
        : { kind: 'revision' as const, revisionId: navigation.previousRevisionId };
  const common = {
    revisionId: navigation.revisionId,
    previousRevisionId: previous?.kind === 'revision' ? previous.revisionId : null,
    nextRevisionId: navigation.nextRevisionId,
    latestRevisionId: navigation.latestRevisionId,
    label: adapter.label,
  };
  if (metadata.type === 'history.retained-metadata') {
    const retainedAdapter = metadata.entries[0];
    if (retainedAdapter === undefined) throw new TypeError('history metadata disappeared');
    return {
      ...common,
      previous,
      actorLabel: retainedAdapter.actorLabel,
      summary: retainedAdapter.summary,
      schemaVersion: retainedAdapter.schemaVersion,
    };
  }
  return common;
};
