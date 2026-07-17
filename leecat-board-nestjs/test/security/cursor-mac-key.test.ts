import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCursorMacKeyV1,
  cursorHmacSha256V1,
} from '../../src/common/security/cursor-mac-key.js';

test('copies a dedicated minimum-32-byte cursor key without an environment fallback', () => {
  const input = Buffer.alloc(32, 7);
  const key = createCursorMacKeyV1(input);
  const expected = cursorHmacSha256V1(key, 'test.cursor.v1\0', Buffer.from('payload'));
  input.fill(9);
  assert.deepEqual(cursorHmacSha256V1(key, 'test.cursor.v1\0', Buffer.from('payload')), expected);
  assert.equal(key.byteLength, 0);
  assert.throws(() => createCursorMacKeyV1(Buffer.alloc(31)), /at least 32 bytes/);
  assert.throws(
    () => cursorHmacSha256V1(new Uint8Array(0) as never, 'test.cursor.v1\0', Buffer.alloc(0)),
    /invalid cursor MAC input/,
  );
});
