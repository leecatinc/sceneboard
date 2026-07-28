import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { AppError, BoardContractError } from '../../src/common/errors/app-error.js';
import { ArtifactBrokerError } from '../../src/common/errors/artifact-broker.error.js';
import { matchRawBodyProfile, parseProfiledBody } from '../../src/common/http/raw-body-profiles.js';

const bytes = (source: string): Uint8Array => new TextEncoder().encode(source);

test('selects static D2 and D1 profiles from method plus canonical pathname only', () => {
  assert.equal(matchRawBodyProfile('POST', '/api/v1/auth/login')?.kind, 'd2-rest-json-body');
  assert.equal(matchRawBodyProfile('GET', '/api/v1/pairings/pair_1')?.kind, 'd2-no-body');
  assert.equal(
    matchRawBodyProfile('POST', '/api/v1/boards/board_1/mutations')?.kind,
    'd1-contract-body',
  );
  assert.equal(
    matchRawBodyProfile('POST', '/api/v1/boards/board_1/revisions/revision_1/restore')?.kind,
    'd1-adapter-body',
  );
  assert.equal(matchRawBodyProfile('GET', '/api/v1/boards/board_1')?.kind, 'd1-no-body');
  assert.equal(
    matchRawBodyProfile('POST', '/api/v1/boards/board_1/title')?.kind,
    'd2-rest-json-body',
  );
  assert.equal(
    matchRawBodyProfile('POST', '/api/v1/boards/board_1/artifacts')?.kind,
    'd7-artifact-source-body',
  );
  assert.equal(
    matchRawBodyProfile(
      'GET',
      '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1/package',
    )?.kind,
    'd1-no-body',
  );
  assert.equal(
    matchRawBodyProfile(
      'POST',
      '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1/capability-requests/network-fetch',
    )?.kind,
    'd7-artifact-network-body',
  );
  assert.equal(
    matchRawBodyProfile('GET', '/api/v1/boards/board_1/interactions/hitl_1')?.kind,
    'd1-no-body',
  );
  assert.equal(
    matchRawBodyProfile('POST', '/api/v1/boards/board_1/interactions/hitl_1/cancel')?.kind,
    'd1-adapter-body',
  );
  assert.equal(matchRawBodyProfile('GET', '/api/v1/unknown'), null);
  assert.equal(matchRawBodyProfile('POST', '/api/v1/auth/login?kind=board'), null);
});

test('admits only the exact bounded digest-bound media binary profile', () => {
  const source = bytes('not-a-real-png-but-transport-valid');
  const digest = createHash('sha256').update(source).digest('base64');
  const profile = matchRawBodyProfile('POST', '/api/v1/boards/board_1/media', 'image/png');
  assert.equal(profile?.kind, 'd9-media-binary-body');
  const invalidTypeProfile = matchRawBodyProfile(
    'POST',
    '/api/v1/boards/board_1/media',
    'application/json',
  );
  assert.equal(invalidTypeProfile?.kind, 'd9-media-binary-body');
  assert.throws(
    () =>
      parseProfiledBody(invalidTypeProfile!, {
        contentType: 'application/json',
        contentLength: String(source.byteLength),
        contentDigest: `sha-256=:${digest}:`,
        body: source,
      }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'INVALID_REQUEST' &&
      error.boardError.details.reason === 'content_type',
  );
  assert.equal(
    parseProfiledBody(profile!, {
      contentType: 'image/png',
      contentLength: String(source.byteLength),
      contentDigest: `sha-256=:${digest}:`,
      body: source,
    }).kind,
    'd9-media-binary-body',
  );
  for (const input of [
    { contentType: 'image/png', contentLength: String(source.byteLength), body: source },
    {
      contentType: 'image/png',
      contentLength: String(source.byteLength),
      contentDigest: `sha-256=:${digest}:`,
      transferEncoding: 'chunked',
      body: source,
    },
    {
      contentType: 'image/png',
      contentLength: String(source.byteLength + 1),
      contentDigest: `sha-256=:${digest}:`,
      body: source,
    },
  ]) {
    assert.throws(
      () => parseProfiledBody(profile!, input),
      (error: unknown) =>
        error instanceof BoardContractError && error.boardError.code === 'INVALID_REQUEST',
    );
  }
  assert.throws(
    () =>
      parseProfiledBody(profile!, {
        contentType: 'image/png',
        contentLength: '10485761',
        contentDigest: `sha-256=:${digest}:`,
        body: new Uint8Array(),
      }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'PAYLOAD_TOO_LARGE',
  );
});

test('retains the strict D7 network body and rejects its 8193-byte one-over sentinel', () => {
  const profile = matchRawBodyProfile(
    'POST',
    '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1/capability-requests/network-fetch',
  );
  assert.ok(profile);
  const source = bytes(
    JSON.stringify({
      protocolVersion: 1,
      type: 'artifact.network.fetch.request',
      requestId: 'AAAAAAAAAAAAAAAAAAAAAA',
      method: 'GET',
      url: 'https://example.com/data.json',
    }),
  );
  const parsed = parseProfiledBody(profile, {
    contentType: 'application/json',
    contentLength: String(source.byteLength),
    body: source,
  });
  assert.equal(parsed.kind, 'd7-artifact-network-body');
  assert.throws(
    () =>
      parseProfiledBody(profile, {
        contentType: 'application/json',
        contentLength: '8193',
        body: new Uint8Array(),
      }),
    ArtifactBrokerError,
  );
});

test('retains the bounded D7 source body and maps its one-over sentinel to artifact total', () => {
  const publish = matchRawBodyProfile('POST', '/api/v1/boards/board_1/artifacts');
  assert.ok(publish);
  const source = bytes(
    '{"boardId":"board_1","expectedRevisionId":"revision_1","idempotencyKey":"0123456789abcdef","artifactId":null,"html":"","css":null,"javascript":null,"requestedCapabilities":[]}',
  );
  const parsed = parseProfiledBody(publish, {
    contentType: 'application/json',
    contentLength: String(source.byteLength),
    body: source,
  });
  assert.equal(parsed.kind, 'd7-artifact-source-body');
  assert.throws(
    () =>
      parseProfiledBody(publish, {
        contentType: 'application/json',
        contentLength: '11534337',
        body: new Uint8Array(),
      }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'PAYLOAD_TOO_LARGE' &&
      'scope' in error.boardError.details &&
      error.boardError.details.scope === 'artifact.total',
  );
});

test('retains a strict restore adapter body for controller translation', () => {
  const restore = matchRawBodyProfile(
    'POST',
    '/api/v1/boards/board_1/revisions/revision_1/restore',
  );
  assert.ok(restore);
  const source = bytes(
    '{"protocolVersion":1,"requestId":"request_01","idempotencyKey":"0123456789abcdef","expectedRevisionId":"revision_2","confirm":true}',
  );
  const parsed = parseProfiledBody(restore, {
    contentType: 'application/json',
    contentLength: String(source.byteLength),
    body: source,
  });
  assert.equal(parsed.kind, 'd1-adapter-body');
  if (parsed.kind === 'd1-adapter-body') {
    assert.equal((parsed.parsedBody as { confirm: unknown }).confirm, true);
    assert.deepEqual(parsed.rawBody, source);
  }
  assert.throws(
    () =>
      parseProfiledBody(restore, {
        contentType: 'application/json',
        body: bytes('{"requestId":"first","requestId":"second"}'),
      }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'INVALID_PAYLOAD',
  );
});

test('maps protected D1 GET body violations to exact board errors', () => {
  const getBoard = matchRawBodyProfile('GET', '/api/v1/boards/board_1');
  assert.ok(getBoard);
  assert.equal(parseProfiledBody(getBoard, { body: new Uint8Array() }).kind, 'd1-no-body');
  assert.throws(
    () => parseProfiledBody(getBoard, { body: bytes('{}') }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'INVALID_PAYLOAD',
  );
});

test('applies exact D2 content-type, required-body, and no-body contracts', () => {
  const login = matchRawBodyProfile('POST', '/api/v1/auth/login');
  assert.ok(login);
  const parsed = parseProfiledBody(login, {
    contentType: 'application/json',
    contentLength: '2',
    body: bytes('{}'),
  });
  assert.equal(parsed.kind, 'd2-rest-json-body');
  assert.equal(Object.getPrototypeOf(parsed.body), null);

  for (const contentType of [undefined, 'application/json; charset=utf-8', ' application/json']) {
    assert.throws(
      () => parseProfiledBody(login, { contentType, contentLength: '2', body: bytes('{}') }),
      AppError,
    );
  }

  const session = matchRawBodyProfile('GET', '/api/v1/auth/session');
  assert.ok(session);
  assert.equal(parseProfiledBody(session, { body: new Uint8Array() }).kind, 'd2-no-body');
  assert.throws(() => parseProfiledBody(session, { body: bytes('{}') }), AppError);
});

test('retains D1 bytes and maps D1 framing failures to exact board errors', () => {
  const create = matchRawBodyProfile('POST', '/api/v1/boards');
  assert.ok(create);
  const source = bytes(
    '{"protocolVersion":1,"requestId":"request_01","type":"board.create","title":"SceneBoard","idempotencyKey":"0123456789abcdef"}',
  );
  const parsed = parseProfiledBody(create, {
    contentType: 'application/json',
    contentLength: String(source.byteLength),
    body: source,
  });
  assert.equal(parsed.kind, 'd1-contract-body');
  if (parsed.kind === 'd1-contract-body') assert.deepEqual(parsed.rawBody, source);

  assert.throws(
    () =>
      parseProfiledBody(create, {
        contentType: 'application/json',
        contentLength: '1048577',
        body: new Uint8Array(),
      }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'PAYLOAD_TOO_LARGE',
  );
  assert.throws(
    () => parseProfiledBody(create, { contentType: 'text/plain', body: source }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'INVALID_PAYLOAD',
  );
});
