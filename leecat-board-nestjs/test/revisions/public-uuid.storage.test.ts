import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatPublicUuidV4,
  generatePublicUuidV4,
  parsePublicUuidV4,
} from '../../src/common/ids/public-uuid.storage.js';

test('maps canonical UUIDv4 text to network-order bytes and back', () => {
  const text = '00112233-4455-4677-8899-aabbccddeeff';
  const bytes = parsePublicUuidV4(text);
  assert.equal(Buffer.from(bytes).toString('hex'), '00112233445546778899aabbccddeeff');
  assert.equal(formatPublicUuidV4(bytes), text);
  assert.equal(generatePublicUuidV4(() => text), text);
});

test('rejects noncanonical, non-v4, and non-RFC UUID values', () => {
  for (const value of [
    '00112233-4455-4677-8899-AABBCCDDEEFF',
    '{00112233-4455-4677-8899-aabbccddeeff}',
    'urn:uuid:00112233-4455-4677-8899-aabbccddeeff',
    '00112233445546778899aabbccddeeff',
    '00112233-4455-3677-8899-aabbccddeeff',
    '00112233-4455-4677-7899-aabbccddeeff',
  ]) assert.throws(() => parsePublicUuidV4(value), /canonical UUIDv4/);
  assert.throws(() => formatPublicUuidV4(Buffer.alloc(15)), /16 bytes/);
});
