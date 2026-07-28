import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
