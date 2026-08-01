import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  HistoryEntryV1,
  PrincipalId,
  RetainedHistoryMetadataV1,
  RevisionId,
  TimestampV1,
} from '@sceneboard/board-schema';

import {
  correlateHistoryListV1,
  correlateHistoryNavigationV1,
  normalizeHistoryListV1,
} from '../../src/client/history-metadata.js';

const revisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as RevisionId;
const entry: HistoryEntryV1 = {
  revision: {
    revisionId,
    revisionNumber: 40,
    createdAt: '2026-07-28T00:00:00.000Z' as TimestampV1,
  },
  previousRevisionId: null,
  originType: 'scene.replace',
  sourceRevisionId: null,
  actor: { principalKind: 'user', principalId: 'user_1' as PrincipalId },
};
const retained: RetainedHistoryMetadataV1 = {
  protocolVersion: 1,
  type: 'history.retained-metadata',
  entries: [
    {
      revisionId,
      label: 'Revision 40',
      actorLabel: 'self',
      summary: 'Scene updated',
      schemaVersion: '1.0.0',
    },
  ],
  boundary: { truncatedBefore: true, oldestRetainedRevisionId: revisionId },
  navigation: {
    revisionId,
    previous: { kind: 'truncated' },
    nextRevisionId: null,
    latestRevisionId: revisionId,
  },
};

test('normalizes retained list metadata without exposing actor identities', () => {
  assert.deepEqual(correlateHistoryListV1([entry], { ...retained, navigation: null }), [
    {
      entry,
      label: 'Revision 40',
      actorLabel: 'self',
      summary: 'Scene updated',
      schemaVersion: '1.0.0',
    },
  ]);
});

test('normalizes a truncated retained predecessor while preserving the legacy alias', () => {
  assert.deepEqual(
    correlateHistoryNavigationV1(entry, retained, { revisionId, revisionNumber: 40 }),
    {
      revisionId,
      previous: { kind: 'truncated' },
      previousRevisionId: null,
      nextRevisionId: null,
      latestRevisionId: revisionId,
      label: 'Revision 40',
      actorLabel: 'self',
      summary: 'Scene updated',
      schemaVersion: '1.0.0',
    },
  );
});

test('produces the strict retained dropdown result from one correlated list boundary', () => {
  const result = normalizeHistoryListV1({
    entries: [entry],
    metadata: {
      ...retained,
      navigation: null,
      boundary: { truncatedBefore: true, oldestRetainedRevisionId: revisionId },
    },
    nextCursor: null,
    requestedCursor: null,
    latest: { revisionId, revisionNumber: 40 },
  });
  assert.deepEqual(result, {
    source: 'history.retained-metadata',
    rows: [
      {
        revisionId,
        revisionNumber: 40,
        createdAt: '2026-07-28T00:00:00.000Z',
        label: 'Revision 40',
        actorLabel: 'self',
        summary: 'Scene updated',
        schemaVersion: '1.0.0',
        previous: { kind: 'truncated' },
        nextRevisionId: null,
      },
    ],
    boundary: { truncatedBefore: true, oldestRetainedRevisionId: revisionId },
    nextCursor: null,
    latest: { revisionId, revisionNumber: 40 },
  });
});

test('preserves correlated persisted adapter labels on the default legacy history path', () => {
  const labels = ['Cleared', 'Updated', 'Created', 'Updated document'];
  const origins = ['scene.clear', 'scene.replace', 'board.create', 'document.replace'] as const;
  const entries = labels.map<HistoryEntryV1>((_label, index) => ({
    ...entry,
    revision: {
      ...entry.revision,
      revisionId: `${String(index + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` as RevisionId,
      revisionNumber: labels.length - index,
    },
    previousRevisionId:
      index === labels.length - 1
        ? null
        : (`${String(index + 2).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` as RevisionId),
    originType: origins[index]!,
  }));
  const result = normalizeHistoryListV1({
    entries,
    metadata: {
      protocolVersion: 1,
      type: 'history.adapter-metadata',
      entries: entries.map((item, index) => ({
        revisionId: item.revision.revisionId,
        label: labels[index]!,
      })),
      navigation: null,
    },
    nextCursor: null,
    requestedCursor: null,
    latest: {
      revisionId: entries[0]!.revision.revisionId,
      revisionNumber: entries[0]!.revision.revisionNumber,
    },
  });

  assert.equal(result.source, 'history.adapter-metadata');
  assert.deepEqual(
    result.rows.map((row) => row.label),
    labels,
  );
});

test('fails closed before UI state for changed labels, summaries, order, or latest tuple', () => {
  const metadata = {
    ...retained,
    navigation: null,
    boundary: { truncatedBefore: false, oldestRetainedRevisionId: revisionId },
  };
  assert.throws(() =>
    normalizeHistoryListV1({
      entries: [entry],
      metadata: {
        ...metadata,
        entries: [{ ...metadata.entries[0]!, label: 'Private board title' }],
      },
      nextCursor: null,
      requestedCursor: null,
      latest: { revisionId, revisionNumber: 40 },
    }),
  );
  assert.throws(() =>
    normalizeHistoryListV1({
      entries: [entry],
      metadata: {
        ...metadata,
        entries: [{ ...metadata.entries[0]!, summary: 'User supplied reason' }],
      },
      nextCursor: null,
      requestedCursor: null,
      latest: { revisionId, revisionNumber: 40 },
    }),
  );
  assert.throws(() =>
    normalizeHistoryListV1({
      entries: [entry],
      metadata,
      nextCursor: null,
      requestedCursor: null,
      latest: { revisionId, revisionNumber: 41 },
    }),
  );
  assert.throws(() =>
    correlateHistoryNavigationV1(entry, retained, {
      revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as RevisionId,
      revisionNumber: 41,
    }),
  );
});
