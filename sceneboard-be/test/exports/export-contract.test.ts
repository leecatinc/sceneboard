import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { EXPORT_FAILURE_DEFINITIONS_V1, ExportFailureV1 } from '../../src/exports/export-errors.js';
import { ExportAuthorizationPolicyV1 } from '../../src/exports/export-authorization.policy.js';
import { ExportGlobalAdmissionRepositoryV1 } from '../../src/exports/export-global-admission.repository.js';
import { canonicalizeExportProjectionV1 } from '../../src/exports/export-projection.service.js';
import { ExportRenderSessionRepositoryV1 } from '../../src/exports/export-render-session.repository.js';
import { ExportRequestSchemaV1 } from '../../src/exports/export-request.schema.js';
import type { RedisService } from '../../src/redis/redis.service.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import type {
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';

const key = Buffer.alloc(32, 7);
const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA';
const token = 'BBBBBBBBBBBBBBBBBBBBBB';

test('export request and frozen failure catalog remain closed and exact', () => {
  assert.deepEqual(ExportRequestSchemaV1.parse({ format: 'pdf', revisionId: null }), {
    format: 'pdf',
    revisionId: null,
  });
  assert.deepEqual(ExportRequestSchemaV1.parse({ format: 'pptx', revisionId: 'revision_1' }), {
    format: 'pptx',
    revisionId: 'revision_1',
  });
  assert.equal(ExportRequestSchemaV1.safeParse({ format: 'pdf' }).success, false);
  assert.equal(ExportRequestSchemaV1.safeParse({ format: 'pdf', output: 'x' }).success, false);
  assert.equal(ExportRequestSchemaV1.safeParse({ format: 'svg' }).success, false);
  assert.deepEqual(Object.keys(EXPORT_FAILURE_DEFINITIONS_V1), [
    'EXPORT_INVALID_REQUEST',
    'EXPORT_UNAUTHENTICATED',
    'EXPORT_FORBIDDEN',
    'EXPORT_NOT_FOUND',
    'EXPORT_REQUIRED_CONTENT_UNSUPPORTED',
    'EXPORT_BOUNDS_EXCEEDED',
    'EXPORT_RATE_LIMITED',
    'EXPORT_RENDERER_UNAVAILABLE',
    'EXPORT_RENDER_TIMEOUT',
    'EXPORT_ENCODE_FAILED',
    'EXPORT_INTERNAL_ERROR',
  ]);
  const timeout = new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
  assert.deepEqual(
    { status: timeout.httpStatus, retryable: timeout.retryable },
    { status: 504, retryable: true },
  );
  assert.deepEqual(timeout.toPayload(), {
    ok: false,
    error: {
      code: 'EXPORT_RENDER_TIMEOUT',
      message: 'Export timed out',
      retryable: true,
    },
  });
});

test('export authorization preserves insufficient API-key scope as forbidden', async () => {
  const boards = {
    async withAuthorizedBoardTransaction() {
      throw new BoardContractError({
        protocolVersion: 1,
        type: 'board.error',
        code: 'FORBIDDEN',
        message: 'Forbidden',
        category: 'auth',
        retryable: false,
        httpStatusHint: 403,
        details: null,
      });
    },
  } as unknown as BoardAccessPolicy;
  const policy = new ExportAuthorizationPolicyV1(boards);
  const principal = {
    kind: 'account_api_key',
    actor: {
      principalKind: 'service',
      principalId: 'key_fixture',
      grantId: null,
      scopes: [],
    },
    ownerUserPk: 1n,
    apiKeyPk: 2n,
    scopeMask: 4,
    isBrowserCredential: false,
  } as unknown as ResolvedBoardPrincipalV1;
  await assert.rejects(
    policy.authorize({
      principal,
      boardId: 'board_fixture' as never,
      async apply() {
        throw new Error('authorization unexpectedly applied');
      },
    }),
    (error) => error instanceof ExportFailureV1 && error.code === 'EXPORT_FORBIDDEN',
  );
});

test('projection JSON canonicalization is deterministic across insertion order', () => {
  assert.equal(
    canonicalizeExportProjectionV1({ z: [3, { b: 2, a: 1 }], a: '한글' }),
    canonicalizeExportProjectionV1({ a: '한글', z: [3, { a: 1, b: 2 }] }),
  );
  assert.equal(
    canonicalizeExportProjectionV1({ z: [3, { b: 2, a: 1 }], a: '한글' }),
    '{"a":"한글","z":[3,{"a":1,"b":2}]}',
  );
});

test('render session uses the exact opaque key, HMAC binding, TTL and Lua protocol', async () => {
  const calls: Array<{
    script: string;
    keys: readonly string[];
    args: readonly string[];
  }> = [];
  const tokenHmac = createHmac('sha256', key).update(token, 'ascii').digest('hex');
  const redis = {
    async evaluate(script: string, keys: readonly string[], args: readonly string[]) {
      calls.push({ script, keys, args });
      if (script.includes("EXISTS', KEYS[1]")) return 1;
      if (args[0] === 'claim') return ['claimed', args[2]];
      if (args[0] === 'debit') return ['debited', '1', args[7]];
      if (args[0] === 'renew') return ['renewed'];
      if (args[0] === 'close') return ['closed'];
      if (args[0] === 'reject') return ['rejected'];
      if (script.includes("HGET', KEYS[1], 'tokenHmac")) return [tokenHmac];
      throw new Error('unexpected Redis call');
    },
  } as unknown as RedisService;
  const sessions = new ExportRenderSessionRepositoryV1(redis, key);
  await sessions.open({
    sessionId,
    token,
    boardPk: 1n,
    revisionPk: 2n,
    projectionSha256: 'a'.repeat(64),
    apiOrigin: 'http://127.0.0.1:3411',
    webOrigin: 'http://127.0.0.1:3410',
    openedAtMs: 1_000,
  });
  assert.equal(calls[0]?.keys[0], `sb:export-render:v1:{${sessionId}}:session`);
  assert.match(calls[0]?.script ?? '', /EXPIRE[^]*60/u);
  assert.equal(await sessions.authorizeToken(sessionId, token), true);
  assert.equal(await sessions.authorizeToken(sessionId, 'CCCCCCCCCCCCCCCCCCCCCC'), false);
  const claim = await sessions.claim({ sessionId, token, nowMs: 1_001 });
  assert.equal(typeof claim, 'string');
  assert.equal(
    await sessions.debitProjection({
      sessionId,
      claimNonce: claim ?? '',
      nowMs: 1_002,
      bytes: 1_048_576,
    }),
    true,
  );
  assert.equal(
    await sessions.debitResource({
      sessionId,
      claimNonce: claim ?? '',
      nowMs: 1_003,
      bytes: 268_435_456,
    }),
    true,
  );
  assert.equal(
    await sessions.renew({
      sessionId,
      claimNonce: claim ?? '',
      nowMs: 1_004,
    }),
    true,
  );
  await sessions.close({
    sessionId,
    claimNonce: claim ?? '',
    nowMs: 1_005,
  });
  const script = await readFile(
    new URL('../../src/exports/export-render-session-v1.lua', import.meta.url),
    'utf8',
  );
  assert.match(script, /state ~= 'open'/u);
  assert.match(script, /budget_exceeded/u);
  assert.match(script, /redis\.call\('DEL', KEYS\[1\]\)/u);
});

test('global export admission uses one expiring four-slot anonymous semaphore', async () => {
  const calls: Array<{ script: string; keys: readonly string[]; args: readonly string[] }> = [];
  const redis = {
    async evaluate(script: string, keys: readonly string[], args: readonly string[]) {
      calls.push({ script, keys, args });
      return 1;
    },
  } as unknown as RedisService;
  const admission = new ExportGlobalAdmissionRepositoryV1(redis);
  assert.equal(await admission.acquire(sessionId, 1_000), true);
  await admission.release(sessionId);
  assert.equal(calls[0]?.keys[0], 'sb:export-render:v1:global');
  assert.deepEqual(calls[0]?.args, ['1000', '181000', '4', sessionId]);
  assert.match(calls[0]?.script ?? '', /ZREMRANGEBYSCORE/u);
  assert.match(calls[0]?.script ?? '', /ZCARD/u);
  assert.match(calls[1]?.script ?? '', /ZREM/u);
  assert.doesNotMatch(
    calls.map(({ keys }) => keys.join(':')).join('\n'),
    /board|revision|api-key/u,
  );
});
