import type { PageCursorV1, RevisionId } from '@sceneboard/board-schema';
import type {
  NormalizedRetainedHistoryResultV1,
  NormalizedRetainedHistoryRowV1,
} from '@sceneboard/board-sdk/client';

export type HistoryPageStateV1 = {
  rows: readonly NormalizedRetainedHistoryRowV1[];
  boundary: NormalizedRetainedHistoryResultV1['boundary'];
  nextCursor: PageCursorV1 | null;
  seenCursors: readonly PageCursorV1[];
  latest: { revisionId: RevisionId; revisionNumber: number };
};

export type HistoryRequestIdentityV1 = {
  boardId: string;
  routeKey: string;
  selectionEpoch: number;
  pageEpoch: number;
  kind: 'list' | 'get' | 'latest';
  cursor: PageCursorV1 | null;
  revisionId: RevisionId | null;
  controller: AbortController;
};

const sameRow = (
  left: NormalizedRetainedHistoryRowV1,
  right: NormalizedRetainedHistoryRowV1,
): boolean =>
  left.revisionId === right.revisionId &&
  left.revisionNumber === right.revisionNumber &&
  left.createdAt === right.createdAt &&
  left.label === right.label &&
  left.actorLabel === right.actorLabel &&
  left.summary === right.summary &&
  left.schemaVersion === right.schemaVersion &&
  left.previous?.kind === right.previous?.kind &&
  (left.previous?.kind !== 'revision' ||
    (right.previous?.kind === 'revision' &&
      left.previous.revisionId === right.previous.revisionId)) &&
  left.nextRevisionId === right.nextRevisionId;

const isBefore = (
  newer: NormalizedRetainedHistoryRowV1,
  older: NormalizedRetainedHistoryRowV1,
): boolean =>
  newer.revisionNumber > older.revisionNumber ||
  (newer.revisionNumber === older.revisionNumber && newer.revisionId > older.revisionId);

export const mergeHistoryPageV1 = (
  current: HistoryPageStateV1 | null,
  page: NormalizedRetainedHistoryResultV1,
  requestedCursor: PageCursorV1 | null,
): HistoryPageStateV1 => {
  if (
    current !== null &&
    (current.latest.revisionId !== page.latest.revisionId ||
      current.latest.revisionNumber !== page.latest.revisionNumber)
  ) {
    throw new TypeError('history page latest tuple changed');
  }
  if (requestedCursor === null && current !== null)
    throw new TypeError('first history page must replace the catalog');
  if (requestedCursor !== null && current === null)
    throw new TypeError('history continuation has no catalog');
  if (
    requestedCursor !== null &&
    (current?.nextCursor !== requestedCursor || current.seenCursors.includes(requestedCursor))
  ) {
    throw new TypeError('history cursor does not match the expected continuation');
  }
  if (current !== null && (current.boundary === null) !== (page.boundary === null)) {
    throw new TypeError('history metadata source changed within one catalog');
  }
  if (
    current?.boundary !== null &&
    current?.boundary !== undefined &&
    page.boundary !== null &&
    (current.boundary.truncatedBefore !== page.boundary.truncatedBefore ||
      current.boundary.oldestRetainedRevisionId !== page.boundary.oldestRetainedRevisionId)
  ) {
    throw new TypeError('history boundary changed within one catalog');
  }
  const rows = current === null ? [] : [...current.rows];
  const byId = new Map(rows.map((row) => [row.revisionId, row]));
  for (const row of page.rows) {
    const existing = byId.get(row.revisionId);
    if (existing !== undefined) {
      if (!sameRow(existing, row)) throw new TypeError('history overlap changed');
      continue;
    }
    const tail = rows.at(-1);
    if (tail !== undefined && !isBefore(tail, row))
      throw new TypeError('history continuation regressed');
    rows.push(row);
    byId.set(row.revisionId, row);
  }
  const seenCursors =
    requestedCursor === null ? [] : [...(current?.seenCursors ?? []), requestedCursor];
  if (
    page.nextCursor !== null &&
    (page.nextCursor === requestedCursor || seenCursors.includes(page.nextCursor))
  ) {
    throw new TypeError('history response repeats a cursor');
  }
  return {
    rows,
    boundary: page.boundary,
    nextCursor: page.nextCursor,
    seenCursors,
    latest: page.latest,
  };
};

export const historySettlementIsCurrentV1 = (
  expected: HistoryRequestIdentityV1,
  current: HistoryRequestIdentityV1 | null,
): boolean =>
  current !== null &&
  !expected.controller.signal.aborted &&
  expected.boardId === current.boardId &&
  expected.routeKey === current.routeKey &&
  expected.selectionEpoch === current.selectionEpoch &&
  expected.pageEpoch === current.pageEpoch &&
  expected.kind === current.kind &&
  expected.cursor === current.cursor &&
  expected.revisionId === current.revisionId &&
  expected.controller === current.controller;
