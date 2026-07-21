import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiResult, BoardGetResult } from '../../lib/api/board-api';
import {
  boardIdFromDetailPath,
  isBoardCreationAutoOpenPath,
  shouldLeaveCurrentBoard,
  selectNewBoard,
} from '../../lib/board/board-lifecycle-navigation';

const board = (boardId: string, createdAt: string) => ({ boardId, createdAt });

const readResult = (value: unknown): ApiResult<BoardGetResult> =>
  value as ApiResult<BoardGetResult>;

test('creation auto-open is limited to the board list and AI connections pages', () => {
  assert.equal(isBoardCreationAutoOpenPath('/boards'), true);
  assert.equal(isBoardCreationAutoOpenPath('/settings/ai-connections'), true);
  assert.equal(isBoardCreationAutoOpenPath('/boards/board_1'), false);
  assert.equal(isBoardCreationAutoOpenPath('/settings'), false);
});

test('board detail parsing accepts only one exact encoded board segment', () => {
  assert.equal(boardIdFromDetailPath('/boards/board_1'), 'board_1');
  assert.equal(boardIdFromDetailPath('/boards/board%20one'), 'board one');
  assert.equal(boardIdFromDetailPath('/boards'), null);
  assert.equal(boardIdFromDetailPath('/boards/board_1/history'), null);
  assert.equal(boardIdFromDetailPath('/boards/%E0%A4%A'), null);
});

test('the initial baseline is not mistaken for a newly created board', () => {
  const boards = [board('board_1', '2026-07-19T00:00:00.000Z')];
  assert.equal(selectNewBoard(new Set(boards.map(({ boardId }) => boardId)), boards), null);
});

test('a poll containing multiple new boards selects the newest with a stable tie break', () => {
  const boards = [
    board('board_existing', '2026-07-18T00:00:00.000Z'),
    board('board_z', '2026-07-19T00:01:00.000Z'),
    board('board_a', '2026-07-19T00:01:00.000Z'),
    board('board_older', '2026-07-19T00:00:59.000Z'),
  ];
  assert.deepEqual(selectNewBoard(new Set(['board_existing']), boards), boards[2]);
});

test('only an explicit archive or not-found response leaves the current board', () => {
  assert.equal(
    shouldLeaveCurrentBoard(
      readResult({
        kind: 'ok',
        value: { board: { archivedAt: null } },
      }),
    ),
    false,
  );
  assert.equal(
    shouldLeaveCurrentBoard(
      readResult({
        kind: 'ok',
        value: { board: { archivedAt: '2026-07-19T00:00:00.000Z' } },
      }),
    ),
    true,
  );
  assert.equal(
    shouldLeaveCurrentBoard(
      readResult({
        kind: 'board_error',
        error: { code: 'BOARD_NOT_FOUND' },
      }),
    ),
    true,
  );
  assert.equal(shouldLeaveCurrentBoard(readResult({ kind: 'api_error', status: 404 })), true);
  assert.equal(shouldLeaveCurrentBoard(readResult({ kind: 'api_error', status: 503 })), false);
  assert.equal(shouldLeaveCurrentBoard(readResult({ kind: 'reconciliation_required' })), false);
  assert.equal(shouldLeaveCurrentBoard(readResult({ kind: 'corrupt_response' })), false);
});
