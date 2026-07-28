import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  BoardBinaryAttemptV1,
  SessionRequestCoordinator,
} from '../../lib/auth/renewal-singleflight';
import { BoardMediaUploadApi } from '../../lib/api/board-media-upload-api';

const attempt = {
  requestId: 'request_media_1',
} as BoardBinaryAttemptV1;

const media = {
  protocolVersion: 1,
  type: 'media.ingest.result',
  requestId: 'request_media_1',
  status: 'created',
  media: {
    mediaId: 'media_1',
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: 640,
    height: 480,
    bytes: 128,
  },
};

const success = (body: unknown, overrides: { status?: number; requestId?: string } = {}) =>
  new Response(JSON.stringify(body), {
    status: overrides.status ?? 201,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Request-Id': overrides.requestId ?? 'request_media_1',
    },
  });

const apiWith = (response: Response | 'uncertain') =>
  new BoardMediaUploadApi({
    async dispatchBoardBinary() {
      return response === 'uncertain'
        ? ({ kind: 'transport_uncertain' } as const)
        : ({
            kind: 'ok',
            value: { response, body: await response.json(), bytes: new Uint8Array() },
          } as const);
    },
  } as unknown as SessionRequestCoordinator);

test('accepts only a fully correlated created media upload envelope', async () => {
  const response = success({
    protocolVersion: 1,
    type: 'board.http.success',
    requestId: 'request_media_1',
    result: media,
  });
  const result = await apiWith(response).upload(
    { attempt, contentDigest: 'digest' },
    new AbortController().signal,
  );
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') assert.equal(result.value.media.mediaId, 'media_1');
});

test('maps transport and every correlation drift to commit uncertainty', async () => {
  assert.deepEqual(
    await apiWith('uncertain').upload(
      { attempt, contentDigest: 'digest' },
      new AbortController().signal,
    ),
    { kind: 'commit_uncertain', reason: 'transport' },
  );
  const cases = [
    success(
      {
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: 'other_request',
        result: media,
      },
      {},
    ),
    success(
      {
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: 'request_media_1',
        result: { ...media, requestId: 'other_request' },
      },
      {},
    ),
    success(
      {
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: 'request_media_1',
        result: media,
      },
      { requestId: 'other_request' },
    ),
    success(
      {
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: 'request_media_1',
        result: { ...media, status: 'replayed' },
      },
      {},
    ),
  ];
  for (const response of cases)
    assert.deepEqual(
      await apiWith(response).upload(
        { attempt, contentDigest: 'digest' },
        new AbortController().signal,
      ),
      { kind: 'commit_uncertain', reason: 'response_contract' },
    );
});

test('admits only a closed status-aligned BoardError envelope', async () => {
  const error = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'FORBIDDEN',
    message: 'Forbidden',
    category: 'auth',
    retryable: false,
    httpStatusHint: 403,
    details: null,
  };
  const response = success({ error }, { status: 403 });
  const result = await apiWith(response).upload(
    { attempt, contentDigest: 'digest' },
    new AbortController().signal,
  );
  assert.equal(result.kind, 'board_error');
  if (result.kind === 'board_error') assert.equal(result.error.code, 'FORBIDDEN');
});
