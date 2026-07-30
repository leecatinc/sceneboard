import type {
  HistoryEntryV1,
  PageCursorV1,
  RetainedHistoryActorLabelV1,
  RevisionId,
} from '@sceneboard/board-schema';

import type { HistoryHttpMetadataV1 } from '../http/index.js';

export type CorrelatedHistoryListV1 = Array<{
  entry: HistoryEntryV1;
  label: string;
  actorLabel?: RetainedHistoryActorLabelV1;
  summary?: string;
  schemaVersion?: '1.0.0' | '2.0.0' | '3.0.0';
}>;

export type NormalizedRetainedHistoryRowV1 = {
  revisionId: RevisionId;
  revisionNumber: number;
  createdAt: string;
  label: string;
  actorLabel: RetainedHistoryActorLabelV1;
  summary:
    | 'Board created'
    | 'Scene updated'
    | 'Scene cleared'
    | 'Revision restored'
    | 'Document updated';
  schemaVersion: '1.0.0' | '2.0.0' | '3.0.0';
  previous: { kind: 'revision'; revisionId: RevisionId } | { kind: 'truncated' } | null;
  nextRevisionId: RevisionId | null;
};

type NormalizedHistoryCommonV1 = {
  rows: NormalizedRetainedHistoryRowV1[];
  nextCursor: PageCursorV1 | null;
  latest: { revisionId: RevisionId; revisionNumber: number };
};

export type NormalizedRetainedHistoryResultV1 =
  | (NormalizedHistoryCommonV1 & {
      source: 'history.adapter-metadata';
      boundary: null;
    })
  | (NormalizedHistoryCommonV1 & {
      source: 'history.retained-metadata';
      boundary: {
        truncatedBefore: boolean;
        oldestRetainedRevisionId: RevisionId;
      };
    });

export type NormalizeHistoryListInputV1 = {
  entries: readonly HistoryEntryV1[];
  metadata: HistoryHttpMetadataV1;
  nextCursor: PageCursorV1 | null;
  requestedCursor: PageCursorV1 | null;
  latest: { revisionId: RevisionId; revisionNumber: number };
};

const HISTORY_SUMMARY_BY_ORIGIN = {
  'board.create': 'Board created',
  'scene.replace': 'Scene updated',
  'scene.clear': 'Scene cleared',
  'scene.restore': 'Revision restored',
  'document.replace': 'Document updated',
} as const;

const validateHistoryOrder = (entries: readonly HistoryEntryV1[]): void => {
  const seen = new Set<RevisionId>();
  for (const [index, entry] of entries.entries()) {
    const revision = entry.revision;
    if (seen.has(revision.revisionId)) throw new TypeError('history response contains a duplicate');
    seen.add(revision.revisionId);
    const previous = entries[index - 1]?.revision;
    if (
      previous !== undefined &&
      (previous.revisionNumber < revision.revisionNumber ||
        (previous.revisionNumber === revision.revisionNumber &&
          previous.revisionId <= revision.revisionId))
    ) {
      throw new TypeError('history response order is not newest first');
    }
  }
};

const retainedPrevious = (
  entry: HistoryEntryV1,
  metadata: HistoryHttpMetadataV1,
): NormalizedRetainedHistoryRowV1['previous'] => {
  if (
    metadata.type === 'history.retained-metadata' &&
    metadata.boundary.truncatedBefore &&
    metadata.boundary.oldestRetainedRevisionId === entry.revision.revisionId
  ) {
    if (entry.previousRevisionId !== null)
      throw new TypeError('truncated retained boundary exposes a predecessor');
    return { kind: 'truncated' };
  }
  return entry.previousRevisionId === null
    ? null
    : { kind: 'revision', revisionId: entry.previousRevisionId };
};

export const normalizeHistoryListV1 = ({
  entries,
  metadata,
  nextCursor,
  requestedCursor,
  latest,
}: NormalizeHistoryListInputV1): NormalizedRetainedHistoryResultV1 => {
  if (metadata.navigation !== null || entries.length !== metadata.entries.length)
    throw new TypeError('history list metadata does not correlate');
  validateHistoryOrder(entries);
  if (
    requestedCursor === null &&
    (entries[0]?.revision.revisionId !== latest.revisionId ||
      entries[0]?.revision.revisionNumber !== latest.revisionNumber)
  ) {
    throw new TypeError('history latest tuple does not correlate');
  }
  const rows = entries.map<NormalizedRetainedHistoryRowV1>((entry, index) => {
    const adapter = metadata.entries[index];
    const revision = entry.revision;
    const expectedLabel = `Revision ${revision.revisionNumber}`;
    if (adapter?.revisionId !== revision.revisionId || adapter.label !== expectedLabel)
      throw new TypeError('history metadata order or label does not correlate');
    const summary = HISTORY_SUMMARY_BY_ORIGIN[entry.originType];
    const previous = retainedPrevious(entry, metadata);
    const nextRevisionId = index === 0 ? null : (entries[index - 1]?.revision.revisionId ?? null);
    if (metadata.type === 'history.retained-metadata') {
      const retained = metadata.entries[index];
      if (
        retained === undefined ||
        retained.summary !== summary ||
        (retained.schemaVersion !== '1.0.0' &&
          retained.schemaVersion !== '2.0.0' &&
          retained.schemaVersion !== '3.0.0')
      ) {
        throw new TypeError('retained history metadata is not render safe');
      }
      return {
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        createdAt: revision.createdAt,
        label: retained.label,
        actorLabel: retained.actorLabel,
        summary,
        schemaVersion: retained.schemaVersion,
        previous,
        nextRevisionId,
      };
    }
    return {
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      createdAt: revision.createdAt,
      label: expectedLabel,
      actorLabel: entry.actor.principalKind === 'service' ? 'system' : 'editor',
      summary,
      schemaVersion: '1.0.0',
      previous,
      nextRevisionId,
    };
  });
  const common = { rows, nextCursor, latest };
  return metadata.type === 'history.retained-metadata'
    ? {
        ...common,
        source: metadata.type,
        boundary: metadata.boundary,
      }
    : {
        ...common,
        source: metadata.type,
        boundary: null,
      };
};

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
  schemaVersion?: '1.0.0' | '2.0.0' | '3.0.0';
};

export const correlateHistoryNavigationV1 = (
  entry: HistoryEntryV1,
  metadata: HistoryHttpMetadataV1,
  latest: { revisionId: RevisionId; revisionNumber: number },
): CorrelatedHistoryNavigationV1 => {
  const revisionId = entry.revision.revisionId;
  const adapter = metadata.entries[0];
  const navigation = metadata.navigation;
  if (
    metadata.entries.length !== 1 ||
    adapter?.revisionId !== revisionId ||
    navigation?.revisionId !== revisionId ||
    navigation.latestRevisionId !== latest.revisionId ||
    !Number.isSafeInteger(latest.revisionNumber) ||
    latest.revisionNumber < entry.revision.revisionNumber
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
