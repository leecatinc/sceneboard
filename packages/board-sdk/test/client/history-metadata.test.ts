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
  assert.deepEqual(correlateHistoryNavigationV1(entry, retained), {
    revisionId,
    previous: { kind: 'truncated' },
    previousRevisionId: null,
    nextRevisionId: null,
    latestRevisionId: revisionId,
    label: 'Revision 40',
    actorLabel: 'self',
    summary: 'Scene updated',
    schemaVersion: '1.0.0',
  });
});
