import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_ERROR_CODES_V2,
  CLIENT_GRANT_CAPABILITIES_V1,
  CLIENT_GRANT_SCOPE_ORDER_V1,
  MediaIngestResultParserV1,
} from '../src/index.js';

const result = {
  protocolVersion: 1,
  type: 'media.ingest.result',
  requestId: 'request_media_1',
  status: 'created',
  media: {
    mediaId: 'media_1',
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: 1,
    height: 1,
    bytes: 68,
  },
};

test('publishes one strict immutable media ingest result', () => {
  assert.equal(MediaIngestResultParserV1.parse(result).ok, true);
  assert.equal(MediaIngestResultParserV1.parse({ ...result, shareToken: 'secret' }).ok, false);
  assert.equal(
    MediaIngestResultParserV1.parse({
      ...result,
      media: { ...result.media, bytes: 10_485_761 },
    }).ok,
    false,
  );
  assert.equal(CLIENT_GRANT_CAPABILITIES_V1.includes('board.media.write'), true);
  assert.deepEqual(CLIENT_GRANT_SCOPE_ORDER_V1, [
    'board.read',
    'board.write',
    'board.history.read',
    'board.hitl.request',
    'board.hitl.respond',
    'board.media.write',
    'artifact.publish',
    'artifact.control',
  ]);
  assert.equal(BOARD_ERROR_CODES_V2.includes('INVALID_MEDIA_UPLOAD'), true);
  assert.equal(BOARD_ERROR_CODES_V2.includes('IDEMPOTENCY_RESULT_EXPIRED'), true);
});
