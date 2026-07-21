import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseHitlLifecycleBody,
  parseHitlReadQuery,
} from '../../src/interactions/interaction-http.dto.js';

test('admits only the exact HITL read wait query pair and bounded timeout', () => {
  const parsed = parseHitlReadQuery({
    query: {
      requestId: 'request_1',
      afterStateUpdatedAt: '2026-07-16T00:00:00.000Z',
      timeoutMs: '30000',
    },
    requestId: 'request_1',
    boardId: 'board_1',
    hitlRequestId: 'hitl_1',
  });
  assert.deepEqual(parsed.wait, {
    afterStateUpdatedAt: '2026-07-16T00:00:00.000Z',
    timeoutMs: 30_000,
  });
  assert.throws(() =>
    parseHitlReadQuery({
      query: { requestId: 'request_1', timeoutMs: '1' },
      requestId: 'request_1',
      boardId: 'board_1',
      hitlRequestId: 'hitl_1',
    }),
  );
  assert.throws(() =>
    parseHitlReadQuery({
      query: { requestId: 'request_1', extra: 'x' },
      requestId: 'request_1',
      boardId: 'board_1',
      hitlRequestId: 'hitl_1',
    }),
  );
});

test('keeps lifecycle adapters strict and validates the successor through D1 identifiers', () => {
  const parsed = parseHitlLifecycleBody({
    body: {
      protocolVersion: 1,
      requestId: 'request_1',
      expectedRevisionId: 'revision_1',
      expectedStateUpdatedAt: '2026-07-16T00:00:00.000Z',
      successorHitlRequestId: 'hitl_2',
    },
    requestId: 'request_1',
    boardId: 'board_1' as never,
    hitlRequestId: 'hitl_1' as never,
    action: 'supersede',
  });
  assert.equal('successorHitlRequestId' in parsed && parsed.successorHitlRequestId, 'hitl_2');
  assert.throws(() =>
    parseHitlLifecycleBody({
      body: {
        protocolVersion: 1,
        requestId: 'request_1',
        expectedRevisionId: 'revision_1',
        expectedStateUpdatedAt: '2026-07-16T00:00:00.000Z',
        unexpected: true,
      },
      requestId: 'request_1',
      boardId: 'board_1' as never,
      hitlRequestId: 'hitl_1' as never,
      action: 'cancel',
    }),
  );
});
