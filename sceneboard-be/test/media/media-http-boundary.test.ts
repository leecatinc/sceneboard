import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import {
  admitSingletonBoardRequestIdQuery,
  admittedBoardRequestId,
} from '../../src/common/http/board-request-correlation.js';

test('admits exactly one raw requestId query and preserves byte-identical correlation', () => {
  const request = {};
  assert.equal(
    admitSingletonBoardRequestIdQuery(
      request,
      '/api/v1/boards/board_1/media?requestId=request%5Fmedia%5F1',
    ),
    'request_media_1',
  );
  assert.equal(admittedBoardRequestId(request), 'request_media_1');
});

test('rejects every missing, duplicate, malformed, case-variant, and extra query before work', () => {
  for (const url of [
    '/api/v1/boards/board_1/media',
    '/api/v1/boards/board_1/media?',
    '/api/v1/boards/board_1/media?requestId=',
    '/api/v1/boards/board_1/media?RequestId=request_media_1',
    '/api/v1/boards/board_1/media?requestId=a&requestId=b',
    '/api/v1/boards/board_1/media?requestId=request_media_1&extra=1',
    '/api/v1/boards/board_1/media?requestId=%ZZ',
    '/api/v1/boards/board_1/media?%72equestId=request_media_1',
  ]) {
    assert.throws(
      () => admitSingletonBoardRequestIdQuery({}, url),
      (error: unknown) =>
        error instanceof BoardContractError &&
        error.boardError.code === 'INVALID_REQUEST' &&
        error.boardError.details.reason === 'request_id',
      url,
    );
  }
});

test('controller owns one binary body, exclusive auth modes, and exact response status seam', async () => {
  const source = await readFile(
    new URL('../../src/media/media.controller.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /SCENEBOARD_RAW_BINARY_BODY/u);
  assert.match(source, /@RequireBoardPrincipal\('media-upload'\)/u);
  assert.match(source, /@RequireOrigin\('browser-or-mcp'\)/u);
  assert.match(source, /@RequireCsrf\('session'\)/u);
  assert.match(source, /if \(outcome\.replayed\) response\.status\(200\)/u);
  assert.doesNotMatch(source, /request\.on|request\.pipe|for await/u);
});
