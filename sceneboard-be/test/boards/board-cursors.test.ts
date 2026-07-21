import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BoardId, GrantId, TimestampV1 } from '@sceneboard/board-schema';

import { BoardListCursorCodec } from '../../src/boards/board-list-cursor.codec.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import { createCursorMacKeyV1 } from '../../src/common/security/cursor-mac-key.js';
import { HistoryCursorCodec } from '../../src/history/history-cursor.codec.js';

const boardA = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const boardB = 'AQECAwQFBgcICQoLDA0ODw' as BoardId;
const invalidCursor = (error: unknown): boolean =>
  error instanceof BoardContractError && error.boardError.code === 'INVALID_PAYLOAD';

test('board cursor binds archive filter and opaque owner/grant access context', () => {
  const codec = new BoardListCursorCodec(createCursorMacKeyV1(Buffer.alloc(32, 7)));
  const owner = { accessKind: 'owner' as const, ownerUserId: '20' };
  const tuple = {
    createdAt: '2026-07-16T12:00:00.000Z' as TimestampV1,
    boardPk: '50',
  };
  const cursor = codec.issue({ includeArchived: false, access: owner, tuple });
  assert.deepEqual(codec.parse({ cursor, includeArchived: false, access: owner }), tuple);
  assert.equal(cursor.includes('20'), false);
  assert.throws(() => codec.parse({ cursor, includeArchived: true, access: owner }), invalidCursor);
  assert.throws(
    () =>
      codec.parse({
        cursor,
        includeArchived: false,
        access: { accessKind: 'owner', ownerUserId: '21' },
      }),
    invalidCursor,
  );
  assert.throws(
    () =>
      codec.parse({
        cursor,
        includeArchived: false,
        access: { accessKind: 'grant', grantId: 'grant_1' as GrantId },
      }),
    invalidCursor,
  );
  const changed = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(
    () => codec.parse({ cursor: changed, includeArchived: false, access: owner }),
    invalidCursor,
  );
});

test('history cursor is signed, canonical, board-bound, and safe-integer bounded', () => {
  const codec = new HistoryCursorCodec(createCursorMacKeyV1(Buffer.alloc(48, 9)));
  const cursor = codec.issue(boardA, Number.MAX_SAFE_INTEGER);
  assert.equal(codec.parse(cursor, boardA), Number.MAX_SAFE_INTEGER);
  assert.throws(() => codec.parse(cursor, boardB), invalidCursor);
  assert.throws(() => codec.issue(boardA, Number.MAX_SAFE_INTEGER + 1), invalidCursor);
  assert.throws(() => codec.parse('A'.repeat(513), boardA), invalidCursor);
});
