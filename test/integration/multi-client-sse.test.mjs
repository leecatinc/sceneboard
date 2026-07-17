import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('multi-client live harness consumes the sole snapshot/replay/cursor/reducer path', async () => {
  const root = new URL('../../', import.meta.url);
  const admission = await readFile(new URL('leecat-board-nestjs/src/sse/stream-admission.guard.ts', root), 'utf8');
  const cut = await readFile(new URL('leecat-board-nestjs/src/sse/board-stream-cut.service.ts', root), 'utf8');
  const client = await readFile(new URL('packages/board-sdk/src/sse/board-stream-client.ts', root), 'utf8');
  const reconciler = await readFile(new URL('packages/board-sdk/src/events/event-reconciler.ts', root), 'utf8');
  assert.match(admission, /Last-Event-ID/u);
  assert.match(cut, /#snapshotCut/u);
  assert.match(cut, /listContiguousEvents/u);
  assert.match(client, /replaceSnapshot/u);
  assert.match(reconciler, /resync_required/u);
});
