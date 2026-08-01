import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type {
  HistoryEntryV1,
  PrincipalId,
  RevisionId,
  TimestampV1,
} from '@sceneboard/board-schema';
import { normalizeHistoryListV1 } from '@sceneboard/board-sdk/client';

const source = readFileSync(
  new URL('../../lib/board/use-board-session.ts', import.meta.url),
  'utf8',
);

test('history paging and selection use independent epochs plus exact abort identities', () => {
  assert.match(source, /const selectionEpoch = useRef\(0\)/);
  assert.match(source, /const pageEpoch = useRef\(0\)/);
  assert.match(source, /const listRequest = useRef<HistoryRequestIdentityV1 \| null>/);
  assert.match(source, /const navigationAbort = useRef<AbortController \| null>/);
  assert.match(source, /historySettlementIsCurrentV1\(identity, listRequest\.current\)/);
  assert.match(source, /active\?\.controller\.abort\(\)/);
  assert.match(source, /navigationAbort\.current\?\.abort\(\)/);
  assert.match(source, /active\.cursor === cursor/);
  assert.match(source, /pageEpoch\.current \+= 1/);
  assert.match(source, /selectionEpoch\.current \+= 1/);
});

test('selected retained 404 falls back to a freshly fetched Latest without identifier copy', () => {
  assert.match(source, /result\.error\.code === 'BOARD_NOT_FOUND'/);
  assert.match(source, /await latest\(true\)/);
  assert.match(source, /announcement: 'selected_unavailable'/);
  assert.doesNotMatch(source, /revisionId.*announcement|announcement.*revisionId/);
});

test('list settlements normalize in the SDK before entering dropdown state', () => {
  assert.match(source, /normalizeHistoryListV1\(\{/);
  assert.match(source, /mergeHistoryPageV1\(historyPage\.current, page, cursor\)/);
  assert.match(source, /status: 'error'/);
  assert.match(source, /announcement: 'history_unavailable'/);
});

test('default adapter metadata keeps persisted backend labels renderable', () => {
  const labels = ['Cleared', 'Updated', 'Created', 'Updated document'];
  const origins = ['scene.clear', 'scene.replace', 'board.create', 'document.replace'] as const;
  const entries = labels.map<HistoryEntryV1>((_label, index) => ({
    revision: {
      revisionId: `${String(index + 1).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` as RevisionId,
      revisionNumber: labels.length - index,
      createdAt: '2026-07-28T00:00:00.000Z' as TimestampV1,
    },
    previousRevisionId:
      index === labels.length - 1
        ? null
        : (`${String(index + 2).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` as RevisionId),
    originType: origins[index]!,
    sourceRevisionId: null,
    actor: { principalKind: 'user', principalId: 'user_1' as PrincipalId },
  }));
  const normalized = normalizeHistoryListV1({
    entries,
    metadata: {
      protocolVersion: 1,
      type: 'history.adapter-metadata',
      entries: entries.map((entry, index) => ({
        revisionId: entry.revision.revisionId,
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

  assert.deepEqual(
    normalized.rows.map((row) => row.label),
    labels,
  );
});

test('retry lifecycle is deterministic: loading disables repeat activation and reuses the failed cursor once', () => {
  // Retry cannot be repeatedly activated while loading or loading more (an in-flight retry already clears failedCursor to null).
  assert.match(
    source,
    /historyDropdown\.status === 'loading' \|\| historyDropdown\.status === 'loading_more'/,
  );
  // The failed cursor is the retry target.
  assert.match(source, /const cursor = historyDropdown\.failedCursor/);
  // On success the error state is replaced with ready and the announcement is cleared.
  assert.match(source, /status: 'ready'/);
  assert.match(source, /failedCursor: null/);
  assert.match(source, /announcement: null/);
});
