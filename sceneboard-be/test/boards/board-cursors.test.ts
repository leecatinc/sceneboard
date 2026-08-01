import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BoardId, GrantId, RevisionId, TimestampV1 } from '@sceneboard/board-schema';

import { BoardListCursorCodec } from '../../src/boards/board-list-cursor.codec.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import { encodeSignedCursorV1 } from '../../src/common/cursors/signed-cursor.js';
import { createCursorMacKeyV1 } from '../../src/common/security/cursor-mac-key.js';
import { HistoryCursorCodec } from '../../src/history/history-cursor.codec.js';

const boardA = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const boardB = 'AQECAwQFBgcICQoLDA0ODw' as BoardId;
const invalidCursor = (error: unknown): boolean =>
  error instanceof BoardContractError && error.boardError.code === 'INVALID_PAYLOAD';

test('board cursor binds page size, archive filter, and opaque owner/grant access context', () => {
  const codec = new BoardListCursorCodec(createCursorMacKeyV1(Buffer.alloc(32, 7)));
  const owner = { accessKind: 'owner' as const, ownerUserId: '20' };
  const tuple = {
    createdAt: '2026-07-16T12:00:00.000Z' as TimestampV1,
    boardId: boardA,
  };
  const cursor = codec.issue({ limit: 50, includeArchived: false, access: owner, tuple });
  assert.deepEqual(
    codec.parse({ cursor, limit: 50, includeArchived: false, access: owner }),
    tuple,
  );
  assert.equal(cursor.includes('20'), false);
  assert.throws(
    () => codec.parse({ cursor, limit: 25, includeArchived: false, access: owner }),
    invalidCursor,
  );
  assert.throws(
    () => codec.parse({ cursor, limit: 50, includeArchived: true, access: owner }),
    invalidCursor,
  );
  assert.throws(
    () =>
      codec.parse({
        cursor,
        limit: 50,
        includeArchived: false,
        access: { accessKind: 'owner', ownerUserId: '21' },
      }),
    invalidCursor,
  );
  assert.throws(
    () =>
      codec.parse({
        cursor,
        limit: 50,
        includeArchived: false,
        access: { accessKind: 'grant', grantId: 'grant_1' as GrantId },
      }),
    invalidCursor,
  );
  const changed = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(
    () => codec.parse({ cursor: changed, limit: 50, includeArchived: false, access: owner }),
    invalidCursor,
  );
});

test('board cursor cannot cross account API keys or reveal their database identities', () => {
  const codec = new BoardListCursorCodec(createCursorMacKeyV1(Buffer.alloc(32, 7)));
  const access = {
    accessKind: 'account_api_key' as const,
    ownerUserId: '20',
    apiKeyId: '70',
  };
  const tuple = {
    createdAt: '2026-07-16T12:00:00.000Z' as TimestampV1,
    boardId: boardA,
  };
  const cursor = codec.issue({ limit: 50, includeArchived: false, access, tuple });
  assert.deepEqual(codec.parse({ cursor, limit: 50, includeArchived: false, access }), tuple);
  const wire = Buffer.from(cursor, 'base64url');
  const payload = JSON.parse(wire.subarray(0, -32).toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ['v', 'k', 'l', 'a', 'x', 't', 'b']);
  assert.equal(payload.v, 3);
  assert.equal(payload.b, boardA);
  assert.equal('p' in payload, false);
  assert.equal('boardPk' in payload, false);
  assert.equal('ownerUserId' in payload, false);
  assert.equal('apiKeyId' in payload, false);
  assert.equal(Object.values(payload).includes('50'), false);
  assert.equal(Object.values(payload).includes('20'), false);
  assert.equal(Object.values(payload).includes('70'), false);
  for (const changed of [
    { ...access, ownerUserId: '21' },
    { ...access, apiKeyId: '71' },
    { accessKind: 'owner' as const, ownerUserId: '20' },
  ]) {
    assert.throws(
      () => codec.parse({ cursor, limit: 50, includeArchived: false, access: changed }),
      invalidCursor,
    );
  }
});

test('board cursor rejects the previous V2 payload containing a raw board primary key', () => {
  const key = createCursorMacKeyV1(Buffer.alloc(32, 7));
  const codec = new BoardListCursorCodec(key);
  const cursor = encodeSignedCursorV1(
    key,
    Buffer.from(
      JSON.stringify({
        v: 2,
        k: 'boards',
        l: 50,
        a: false,
        x: 'legacy-context',
        t: '2026-07-16T12:00:00.000Z',
        p: '50',
      }),
      'utf8',
    ),
  );
  assert.throws(
    () =>
      codec.parse({
        cursor,
        limit: 50,
        includeArchived: false,
        access: { accessKind: 'owner', ownerUserId: '20' },
      }),
    invalidCursor,
  );
});

test('history cursor is signed, canonical, board-bound, and safe-integer bounded', () => {
  const key = createCursorMacKeyV1(Buffer.alloc(48, 9));
  const codec = new HistoryCursorCodec(key);
  const context = {
    boardId: boardA,
    limit: 50,
    access: { accessKind: 'owner' as const, ownerUserId: '20' },
    retentionBoundary: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as RevisionId,
  };
  const cursor = codec.issue({ ...context, beforeRevisionNumber: Number.MAX_SAFE_INTEGER });
  assert.equal(codec.parse(cursor, context), Number.MAX_SAFE_INTEGER);
  assert.equal(cursor.includes('20'), false);
  assert.throws(() => codec.parse(cursor, { ...context, boardId: boardB }), invalidCursor);
  assert.throws(() => codec.parse(cursor, { ...context, limit: 25 }), invalidCursor);
  assert.throws(
    () =>
      codec.parse(cursor, {
        ...context,
        retentionBoundary: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as RevisionId,
      }),
    invalidCursor,
  );
  for (const access of [
    { accessKind: 'owner' as const, ownerUserId: '21' },
    { accessKind: 'grant' as const, grantId: 'grant_1' as GrantId },
    { accessKind: 'account_api_key' as const, ownerUserId: '20', apiKeyId: '70' },
  ]) {
    assert.throws(() => codec.parse(cursor, { ...context, access }), invalidCursor);
  }
  assert.throws(
    () => codec.issue({ ...context, beforeRevisionNumber: Number.MAX_SAFE_INTEGER + 1 }),
    invalidCursor,
  );
  assert.throws(() => codec.parse('A'.repeat(513), context), invalidCursor);
  assert.deepEqual(codec.parseAnchor(cursor, context), {
    version: 3,
    kind: 'revision',
    value: Number.MAX_SAFE_INTEGER,
  });
  const retained = codec.issueRetained({ ...context, retainedOrder: 9 });
  assert.deepEqual(codec.parseAnchor(retained, context), {
    version: 3,
    kind: 'retained',
    value: 9,
  });
  const legacy = encodeSignedCursorV1(
    key,
    Buffer.from(JSON.stringify({ v: 2, k: 'history', b: boardA, o: 9 }), 'utf8'),
  );
  assert.throws(() => codec.parse(legacy, context), invalidCursor);
});
