import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_OPERATION_TYPES_V1,
  BOARD_LIMITS_V1,
  BoardOperationEnvelopeParserV1,
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  buildBoardOperationFingerprintV1,
  type BoardLifecycleIdempotencyEnvelopeV1,
} from '../src/index.js';
import { loadFixture } from './helpers/load-fixture.js';

test('accepts each exact lifecycle and query request/result tag', async () => {
  assert.equal(BOARD_OPERATION_TYPES_V1.length, 9);
  for (const type of [
    'board-list',
    'board-get',
    'board-create',
    'board-archive',
    'capabilities-get',
    'history-list',
    'history-get',
    'artifact-get',
    'hitl-read',
  ]) {
    assert.equal(
      BoardOperationRequestParserV1.parse(
        await loadFixture(`valid/operation-request-${type}.v1.json`),
      ).ok,
      true,
      type,
    );
    assert.equal(
      BoardOperationResultParserV1.parse(
        await loadFixture(`valid/operation-result-${type}.v1.json`),
      ).ok,
      true,
      type,
    );
  }
});

test('requires literal archive confirmation and a non-null created head', async () => {
  assert.equal(
    BoardOperationRequestParserV1.parse(
      await loadFixture('invalid/operation-board-archive-confirm-false.v1.json'),
    ).ok,
    false,
  );
  const created = BoardOperationResultParserV1.parse(
    await loadFixture('valid/operation-result-board-create.v1.json'),
  );
  assert.equal(created.ok, true);
  if (created.ok && created.data.value.result.type === 'board.create') {
    assert.equal(created.data.value.result.snapshot.revision.revisionNumber, 1);
    assert.equal(created.data.value.result.snapshot.scene.root, null);
  }
});

test('builds exact create and archive lifecycle fingerprints', async () => {
  for (const type of ['board-create', 'board-archive'] as const) {
    const envelope = (await loadFixture(
      `valid/operation-envelope-${type}.v1.json`,
    )) as BoardLifecycleIdempotencyEnvelopeV1;
    const result = buildBoardOperationFingerprintV1(envelope);
    assert.equal(result.ok, true, type);
    if (result.ok) {
      const text = new TextDecoder().decode(result.data.canonicalBytes);
      assert.doesNotMatch(text, /requestId|idempotencyKey/);
      assert.match(text, /operationType/);
    }
  }
});

test('allows replay only for create and archive operation results', async () => {
  for (const type of [
    'board-list',
    'board-get',
    'capabilities-get',
    'history-list',
    'history-get',
    'artifact-get',
    'hitl-read',
  ]) {
    const value = (await loadFixture(`valid/operation-result-${type}.v1.json`)) as Record<
      string,
      unknown
    >;
    assert.equal(BoardOperationResultParserV1.parse({ ...value, replayed: true }).ok, false, type);
  }
  for (const type of ['board-create', 'board-archive']) {
    const value = (await loadFixture(`valid/operation-result-${type}.v1.json`)) as Record<
      string,
      unknown
    >;
    assert.equal(BoardOperationResultParserV1.parse({ ...value, replayed: true }).ok, true, type);
  }
});

test('correlates board, history, and artifact operation results', async () => {
  const board = (await loadFixture('valid/operation-result-board-get.v1.json')) as Record<
    string,
    unknown
  >;
  const boardResult = board.result as Record<string, unknown>;
  const boardSnapshot = boardResult.snapshot as Record<string, unknown>;
  assert.equal(
    BoardOperationResultParserV1.parse({
      ...board,
      result: { ...boardResult, snapshot: { ...boardSnapshot, boardId: 'board_other' } },
    }).ok,
    false,
  );

  const history = (await loadFixture('valid/operation-result-history-get.v1.json')) as Record<
    string,
    unknown
  >;
  const historyResult = history.result as Record<string, unknown>;
  const historySnapshot = historyResult.snapshot as Record<string, unknown>;
  assert.equal(
    BoardOperationResultParserV1.parse({
      ...history,
      result: {
        ...historyResult,
        snapshot: {
          ...historySnapshot,
          revision: { ...(historySnapshot.revision as object), revisionId: 'revision_other' },
        },
      },
    }).ok,
    false,
  );

  const artifact = (await loadFixture('valid/operation-result-artifact-get.v1.json')) as Record<
    string,
    unknown
  >;
  const artifactResult = artifact.result as Record<string, unknown>;
  const runtime = artifactResult.runtime as Record<string, unknown>;
  assert.equal(
    BoardOperationResultParserV1.parse({
      ...artifact,
      result: {
        ...artifactResult,
        runtime: { ...runtime, artifact: { artifactId: 'artifact_other', versionId: 'version_1' } },
      },
    }).ok,
    false,
  );
});

test('rejects non-normalized operation actors and non-lifecycle fingerprint inputs', async () => {
  const envelope = (await loadFixture('valid/operation-envelope-board-create.v1.json')) as Record<
    string,
    unknown
  >;
  const actor = envelope.actor as Record<string, unknown>;
  const invalid = { ...envelope, actor: { ...actor, scopes: ['board.write', 'board.read'] } };
  const parsed = BoardOperationEnvelopeParserV1.parse(invalid);
  assert.equal(parsed.ok, false);
  if (!parsed.ok)
    assert.deepEqual(parsed.error.details, {
      path: ['actor', 'scopes'],
      issue: 'scopes must be sorted and unique',
    });

  const readEnvelope = (await loadFixture(
    'valid/operation-envelope-board-get.v1.json',
  )) as BoardLifecycleIdempotencyEnvelopeV1;
  assert.equal(buildBoardOperationFingerprintV1(readEnvelope).ok, false);
});

test('keeps page, cursor, and HITL wait limits reachable with stable errors', async () => {
  const list = (await loadFixture('valid/operation-request-board-list.v1.json')) as Record<
    string,
    unknown
  >;
  assert.equal(
    BoardOperationRequestParserV1.parse({ ...list, limit: BOARD_LIMITS_V1.maxPageSize }).ok,
    true,
  );
  const pageOver = BoardOperationRequestParserV1.parse({
    ...list,
    limit: BOARD_LIMITS_V1.maxPageSize + 1,
  });
  assert.equal(pageOver.ok, false);
  if (!pageOver.ok)
    assert.deepEqual(pageOver.error.details, {
      limit: 'maxPageSize',
      actual: 101,
      maximum: 100,
      path: ['limit'],
    });

  const history = (await loadFixture('valid/operation-request-history-list.v1.json')) as Record<
    string,
    unknown
  >;
  assert.equal(
    BoardOperationRequestParserV1.parse({
      ...history,
      cursor: 'a'.repeat(BOARD_LIMITS_V1.maxPageCursorChars),
    }).ok,
    true,
  );
  const cursorOver = BoardOperationRequestParserV1.parse({
    ...history,
    cursor: 'a'.repeat(BOARD_LIMITS_V1.maxPageCursorChars + 1),
  });
  assert.equal(cursorOver.ok, false);
  if (!cursorOver.ok)
    assert.deepEqual(cursorOver.error.details, {
      limit: 'maxPageCursorChars',
      actual: 513,
      maximum: 512,
      path: ['cursor'],
    });

  const hitlRead = (await loadFixture('valid/operation-request-hitl-read.v1.json')) as Record<
    string,
    unknown
  >;
  const wait = {
    afterStateUpdatedAt: '2026-07-16T00:00:00.000Z',
    timeoutMs: BOARD_LIMITS_V1.maxHitlWaitMs,
  };
  assert.equal(BoardOperationRequestParserV1.parse({ ...hitlRead, wait }).ok, true);
  const waitOver = BoardOperationRequestParserV1.parse({
    ...hitlRead,
    wait: { ...wait, timeoutMs: BOARD_LIMITS_V1.maxHitlWaitMs + 1 },
  });
  assert.equal(waitOver.ok, false);
  if (!waitOver.ok)
    assert.deepEqual(waitOver.error.details, {
      limit: 'maxHitlWaitMs',
      actual: 30_001,
      maximum: 30_000,
      path: ['wait', 'timeoutMs'],
    });
});
