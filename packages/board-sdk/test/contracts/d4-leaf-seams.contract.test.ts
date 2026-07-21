import assert from 'node:assert/strict';
import test from 'node:test';

import * as events from '../../src/events/index.js';
import * as sse from '../../src/sse/index.js';
import type {
  BoardEventReconcilerV1,
  BoardEventReconcileResultV1,
} from '../../src/events/index.js';
import type { BoardStreamClientV1, BoardStreamFailureV1 } from '../../src/sse/index.js';

const compileTypes = (
  _reconciler: BoardEventReconcilerV1 | null,
  _eventResult: BoardEventReconcileResultV1 | null,
  _client: BoardStreamClientV1 | null,
  _failure: BoardStreamFailureV1 | null,
): void => undefined;

test('D4 event and SSE leaf barrels expose only their frozen runtimes', () => {
  compileTypes(null, null, null, null);
  assert.deepEqual(Object.keys(events).sort(), ['createBoardEventReconcilerV1']);
  assert.deepEqual(Object.keys(sse).sort(), [
    'createBoardStreamClientV1',
    'createBoardStreamTabIdV1',
  ]);
});
