import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import type { BoardDocumentV3, BoardId, RevisionId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

const exportContractDeadlineKeepAlive = setInterval(() => undefined, 1_000);
after(() => clearInterval(exportContractDeadlineKeepAlive));

import { parsePublicUuidV4 } from '../../src/common/ids/public-uuid.storage.js';
import type { MysqlService } from '../../src/database/mysql.service.js';
import {
  awaitOwnedDatabaseOperation,
  type DatabaseOperationOwnershipV1,
} from '../../src/database/transaction.js';
import { BoardEventOutboxRepository } from '../../src/events/board-event-outbox.repository.js';
import { OutboxDispatcherService } from '../../src/events/outbox-dispatcher.service.js';
import { ExportAdmissionServiceV1 } from '../../src/exports/export-admission.service.js';
import { EXPORT_FAILURE_DEFINITIONS_V1, ExportFailureV1 } from '../../src/exports/export-errors.js';
import {
  EXPORT_GLOBAL_LEASE_MS_V1,
  ExportGlobalAdmissionRepositoryV1,
} from '../../src/exports/export-global-admission.repository.js';
import {
  canonicalizeExportProjectionV1,
  assertExportArtifactPageResidentMemoryV1,
  ExportProjectionServiceV1,
  type ExportProjectionBundleV1,
  type ExportProjectionResourceV1,
  type ImmutableExportProjectionV1,
} from '../../src/exports/export-projection.service.js';
import {
  ExportRevisionHoldConflictV1,
  ExportRevisionHoldRepositoryV1,
} from '../../src/exports/export-revision-hold.repository.js';
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';
import { ExportRenderSessionRepositoryV1 } from '../../src/exports/export-render-session.repository.js';
import { ExportRequestSchemaV1 } from '../../src/exports/export-request.schema.js';
import {
  EXPORT_ARTIFACT_PAGE_RESIDENT_MAX_BYTES_V1,
  EXPORT_RESOURCE_MAX_BYTES_V1,
  EXPORT_RESOURCE_MAX_COUNT_V1,
  EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1,
} from '../../src/exports/export-request.schema.js';
import type { RedisService } from '../../src/redis/redis.service.js';
import { RedisStreamKeyspace } from '../../src/redis/redis-stream-keyspace.js';
import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';

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
  let redisNowMs = 1_000;
  const leases = new Map<string, number>();
  const redis = {
    async evaluate(script: string, keys: readonly string[], args: readonly string[]) {
      calls.push({ script, keys, args });
      if (script.includes("redis.call('TIME')")) {
        for (const [leaseSessionId, expiresAt] of leases) {
          if (expiresAt <= redisNowMs) leases.delete(leaseSessionId);
        }
        if (args.length === 2) {
          const holderId = args[1] ?? '';
          if (!leases.has(holderId)) return 0;
          leases.set(holderId, redisNowMs + Number(args[0]));
          return 1;
        }
        const holderId = args[2] ?? '';
        if (!leases.has(holderId) && leases.size >= Number(args[1])) return 0;
        leases.set(holderId, redisNowMs + Number(args[0]));
        return 1;
      }
      leases.delete(args[0] ?? '');
      return 1;
    },
  } as unknown as RedisService;
  const firstNode = new ExportGlobalAdmissionRepositoryV1(redis);
  const secondNode = new ExportGlobalAdmissionRepositoryV1(redis);
  const sessionIds = ['A', 'B', 'C', 'D', 'E'].map((value) => value.repeat(22));
  const lease = (candidateSessionId: string, generation: string) => ({
    sessionId: candidateSessionId,
    generation,
  });
  const firstLeases = sessionIds
    .slice(0, 4)
    .map((candidate, index) => lease(candidate, String(index + 1).repeat(22)));
  for (const candidate of firstLeases) {
    assert.equal(await firstNode.acquire(candidate), true);
  }
  assert.equal(await firstNode.renew(firstLeases[0]!), true);
  const fifthLease = lease(sessionIds[4] ?? '', '5'.repeat(22));
  assert.equal(await secondNode.acquire(fifthLease), false);
  redisNowMs += 180_001;
  assert.equal(await firstNode.renew(firstLeases[0]!), false);
  const replacementLeases = [
    fifthLease,
    lease('F'.repeat(22), '6'.repeat(22)),
    lease('G'.repeat(22), '7'.repeat(22)),
    lease('H'.repeat(22), '8'.repeat(22)),
  ];
  for (const candidate of replacementLeases)
    assert.equal(await secondNode.acquire(candidate), true);
  assert.equal(await firstNode.acquire(lease('I'.repeat(22), '9'.repeat(22))), false);
  for (const candidate of replacementLeases) await secondNode.release(candidate);

  const olderGeneration = lease(sessionIds[0] ?? '', 'X'.repeat(22));
  const newerGeneration = lease(sessionIds[0] ?? '', 'Y'.repeat(22));
  assert.equal(await firstNode.acquire(olderGeneration), true);
  assert.equal(await secondNode.acquire(newerGeneration), true);
  await secondNode.release(newerGeneration);
  assert.equal(leases.has(`${olderGeneration.sessionId}_${olderGeneration.generation}`), true);
  assert.equal(leases.has(`${newerGeneration.sessionId}_${newerGeneration.generation}`), false);
  await firstNode.release(olderGeneration);
  assert.equal(calls[0]?.keys[0], 'sb:export-render:v1:global');
  assert.deepEqual(calls[0]?.args, [
    '180000',
    '4',
    `${firstLeases[0]?.sessionId}_${firstLeases[0]?.generation}`,
  ]);
  assert.match(calls[0]?.script ?? '', /redis\.call\('TIME'\)/u);
  assert.match(calls[0]?.script ?? '', /ZREMRANGEBYSCORE/u);
  assert.match(calls[0]?.script ?? '', /ZCARD/u);
  const renewalCall = calls.find(({ args }) => args.length === 2 && args[1]?.includes('_'));
  assert.deepEqual(renewalCall?.args, [
    String(EXPORT_GLOBAL_LEASE_MS_V1),
    `${firstLeases[0]?.sessionId}_${firstLeases[0]?.generation}`,
  ]);
  assert.match(renewalCall?.script ?? '', /ZADD'[\s\S]*'XX'/u);
  assert.match(calls.at(-1)?.script ?? '', /ZREM/u);
  assert.equal(leases.has(`${fifthLease.sessionId}_${fifthLease.generation}`), false);
  assert.doesNotMatch(
    calls.map(({ keys }) => keys.join(':')).join('\n'),
    /board|revision|api-key/u,
  );
});

const lifecyclePrincipal = (): ResolvedBoardPrincipalV1 =>
  ({
    kind: 'account_api_key',
    actor: {
      principalKind: 'service',
      principalId: 'key_lifecycle_fixture',
      grantId: null,
      scopes: ['export:read'],
    },
    ownerUserPk: 20n,
    apiKeyPk: 70n,
    scopeMask: 32,
    isBrowserCredential: false,
  }) as unknown as ResolvedBoardPrincipalV1;

type LifecycleTerminalIntentV1 =
  | Readonly<{ outcome: 'pending' }>
  | Readonly<{ outcome: 'completed'; bytes: number }>
  | Readonly<{ outcome: 'failed'; reason: string }>;

const createLifecycleAdmission = (input: {
  project: (holdOwnerId: string) => Promise<{
    projection: { revisionNumber: number };
    projectionSha256: string;
    hold: { boardPk: bigint; revisionPk: bigint; holderId: string };
  }>;
  globalAdmission: {
    acquire(lease: { sessionId: string; generation: string }): Promise<boolean>;
    renew(lease: { sessionId: string; generation: string }): Promise<boolean>;
    release(lease: { sessionId: string; generation: string }): Promise<void>;
  };
  releaseHold?: (holderId: string) => Promise<void>;
  runtime: {
    now(): number;
    scheduleInterval(operation: () => void, intervalMs: number): () => void;
    wait(milliseconds: number): Promise<void>;
  };
  terminalIntents?: Map<string, LifecycleTerminalIntentV1>;
  terminalOwnerships?: DatabaseOperationOwnershipV1[];
  afterAuthorizationApply?: () => Promise<void>;
  onAuthorizationRollback?: () => void;
  beforeTerminalReserve?: (correlationId: string) => void | Promise<void>;
  onTerminalFinalizeAttempt?: (correlationId: string) => void;
  beforeTerminalPersist?: (correlationId: string) => void | Promise<void>;
  beforeTerminalConnection?: (ownership: DatabaseOperationOwnershipV1) => Promise<void>;
  onTerminalPersisted?: (correlationId: string, outcome: 'completed' | 'failed') => void;
}): ExportAdmissionServiceV1 => {
  let issuedSessions = 0;
  const connection = {
    async execute() {
      return [[{ boardPk: '50', ownerUserPk: '20', title: 'Board' }], []];
    },
  };
  const terminalIntents = input.terminalIntents ?? new Map<string, LifecycleTerminalIntentV1>();
  const persistedTerminalAudits = new Set<string>();
  return new ExportAdmissionServiceV1(
    {
      async authorize(request: {
        apply: (connection: unknown, context: { ownerUserPk: bigint }) => Promise<unknown>;
      }) {
        const terminalIntentSnapshot = new Map(terminalIntents);
        try {
          const authorized = await request.apply(connection, { ownerUserPk: 20n });
          await input.afterAuthorizationApply?.();
          return authorized;
        } catch (error) {
          terminalIntents.clear();
          for (const [correlationId, intent] of terminalIntentSnapshot)
            terminalIntents.set(correlationId, intent);
          input.onAuthorizationRollback?.();
          throw error;
        }
      },
    } as never,
    {
      async project(_connection: unknown, request: { holdOwnerId: string }) {
        return input.project(request.holdOwnerId);
      },
    } as never,
    {
      issueCredentials() {
        issuedSessions += 1;
        const value = String.fromCharCode(64 + issuedSessions).repeat(22);
        return { sessionId: value, token: value.toLowerCase() };
      },
      async open() {},
      async cancel() {},
    } as never,
    { register() {}, async dispose() {} } as never,
    {
      async render(request: {
        bundle: { projection: { revisionNumber: number } };
        acceptOwnership?: () => void;
      }) {
        request.acceptOwnership?.();
        return {
          projection: request.bundle.projection,
          async completeResponse() {},
          async abort() {},
        };
      },
    } as never,
    input.globalAdmission as never,
    {
      async renew() {},
      async release(_connection: unknown, hold: { holderId: string }) {
        await input.releaseHold?.(hold.holderId);
        return true;
      },
    } as never,
    { async started() {} } as never,
    {
      async reserve(_connection: unknown, intent: { correlationId: string }) {
        await input.beforeTerminalReserve?.(intent.correlationId);
        const existing = terminalIntents.get(intent.correlationId);
        if (existing !== undefined) return existing.outcome;
        terminalIntents.set(intent.correlationId, { outcome: 'pending' });
        return 'pending' as const;
      },
      async finalize(
        _connection: unknown,
        intent: {
          correlationId: string;
          outcome: 'completed' | 'failed';
          bytes?: number;
          reason?: string;
        },
      ) {
        input.onTerminalFinalizeAttempt?.(intent.correlationId);
        const existing = terminalIntents.get(intent.correlationId);
        assert.ok(existing !== undefined);
        if (existing.outcome === 'pending') {
          if (intent.outcome === 'completed') {
            assert.equal(typeof intent.bytes, 'number');
            terminalIntents.set(intent.correlationId, {
              outcome: 'completed',
              bytes: intent.bytes!,
            });
          } else {
            assert.equal(typeof intent.reason, 'string');
            terminalIntents.set(intent.correlationId, {
              outcome: 'failed',
              reason: intent.reason!,
            });
          }
        }
        return terminalIntents.get(intent.correlationId)!.outcome;
      },
      async persist(_connection: unknown, correlationId: string) {
        await input.beforeTerminalPersist?.(correlationId);
        const intent = terminalIntents.get(correlationId);
        assert.ok(intent !== undefined && intent.outcome !== 'pending');
        if (persistedTerminalAudits.has(correlationId)) return false;
        persistedTerminalAudits.add(correlationId);
        input.onTerminalPersisted?.(correlationId, intent.outcome);
        return true;
      },
    } as never,
    {
      withConnection: <T>(
        work: (value: typeof connection) => Promise<T>,
        ownership?: DatabaseOperationOwnershipV1,
      ) => {
        if (ownership !== undefined) input.terminalOwnerships?.push(ownership);
        const acquired =
          ownership === undefined || input.beforeTerminalConnection === undefined
            ? Promise.resolve(connection)
            : input.beforeTerminalConnection(ownership).then(() => connection);
        return awaitOwnedDatabaseOperation(acquired, ownership).then((ownedConnection) =>
          awaitOwnedDatabaseOperation(work(ownedConnection), ownership),
        );
      },
    } as unknown as MysqlService,
    {
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3410',
      artifactRuntimeOrigin: 'http://127.0.0.2:3412',
    },
    input.runtime as never,
  );
};

const createRolledBackReservationProbe = (input: {
  beforeTerminalReserve?: (correlationId: string) => void | Promise<void>;
  afterAuthorizationApply?: () => Promise<void>;
  onAuthorizationRollback?: () => void;
}) => {
  const terminalIntents = new Map<string, LifecycleTerminalIntentV1>();
  const observations = { finalizeAttempts: 0, retryWaits: 0 };
  const service = createLifecycleAdmission({
    globalAdmission: {
      async acquire() {
        return true;
      },
      async renew() {
        return true;
      },
      async release() {},
    },
    project: async (holderId) => ({
      projection: { revisionNumber: 1 },
      projectionSha256: 'a'.repeat(64),
      hold: { boardPk: 50n, revisionPk: 60n, holderId },
    }),
    runtime: {
      now: () => Date.now(),
      scheduleInterval: () => () => undefined,
      wait: async () => {
        observations.retryWaits += 1;
        await new Promise<void>(() => undefined);
      },
    },
    terminalIntents,
    ...(input.beforeTerminalReserve === undefined
      ? {}
      : { beforeTerminalReserve: input.beforeTerminalReserve }),
    ...(input.afterAuthorizationApply === undefined
      ? {}
      : { afterAuthorizationApply: input.afterAuthorizationApply }),
    ...(input.onAuthorizationRollback === undefined
      ? {}
      : { onAuthorizationRollback: input.onAuthorizationRollback }),
    onTerminalFinalizeAttempt: () => {
      observations.finalizeAttempts += 1;
    },
  });
  return { observations, service, terminalIntents };
};

test('projection abort retains local and fleet ownership through late hold cleanup', async () => {
  let activeGlobalLease: string | null = null;
  const globalAdmission = {
    async acquire(lease: { sessionId: string; generation: string }) {
      if (activeGlobalLease !== null) return false;
      activeGlobalLease = `${lease.sessionId}_${lease.generation}`;
      return true;
    },
    async renew(lease: { sessionId: string; generation: string }) {
      return activeGlobalLease === `${lease.sessionId}_${lease.generation}`;
    },
    async release(lease: { sessionId: string; generation: string }) {
      if (activeGlobalLease === `${lease.sessionId}_${lease.generation}`) activeGlobalLease = null;
    },
  };
  let resolveProjection:
    | ((value: {
        projection: { revisionNumber: number };
        projectionSha256: string;
        hold: { boardPk: bigint; revisionPk: bigint; holderId: string };
      }) => void)
    | undefined;
  let projectionStarted: (() => void) | undefined;
  const projectionStart = new Promise<void>((resolve) => {
    projectionStarted = resolve;
  });
  let projectionCalls = 0;
  let releaseHoldStarted: (() => void) | undefined;
  const holdReleaseStart = new Promise<void>((resolve) => {
    releaseHoldStarted = resolve;
  });
  let resolveHoldRelease: (() => void) | undefined;
  const holdRelease = new Promise<void>((resolve) => {
    resolveHoldRelease = resolve;
  });
  const runtime = {
    now: () => 1_000,
    scheduleInterval: () => () => undefined,
    wait: async () => undefined,
  };
  const service = createLifecycleAdmission({
    globalAdmission,
    runtime,
    project: async (holderId) => {
      projectionCalls += 1;
      if (projectionCalls > 1)
        return {
          projection: { revisionNumber: 2 },
          projectionSha256: 'b'.repeat(64),
          hold: { boardPk: 50n, revisionPk: 61n, holderId },
        };
      projectionStarted?.();
      return new Promise((resolve) => {
        resolveProjection = resolve;
      });
    },
    releaseHold: async () => {
      releaseHoldStarted?.();
      await holdRelease;
    },
  });
  const controller = new AbortController();
  const pendingAdmission = service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'projection_abort_fixture',
    signal: controller.signal,
    deadlineMs: Date.now() + 120_000,
  });
  await projectionStart;
  controller.abort();
  await assert.rejects(
    pendingAdmission,
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
  );
  await assert.rejects(
    service.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: 'projection_local_replacement',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 120_000,
    }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
  );
  const fleetReplacement = createLifecycleAdmission({
    globalAdmission,
    runtime,
    project: async (holderId) => ({
      projection: { revisionNumber: 3 },
      projectionSha256: 'c'.repeat(64),
      hold: { boardPk: 50n, revisionPk: 62n, holderId },
    }),
  });
  await assert.rejects(
    fleetReplacement.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: 'projection_fleet_replacement',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 120_000,
    }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
  );
  resolveProjection?.({
    projection: { revisionNumber: 1 },
    projectionSha256: 'a'.repeat(64),
    hold: { boardPk: 50n, revisionPk: 60n, holderId: `${'A'.repeat(22)}_${'B'.repeat(22)}` },
  });
  await holdReleaseStart;
  assert.notEqual(activeGlobalLease, null);
  resolveHoldRelease?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeGlobalLease, null);
  const replacement = await service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'projection_reconciled',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120_000,
  });
  await replacement.abort();
});

test('lost global renewal fails delivery and quarantines local ownership until cleanup', async () => {
  let activeLease: string | null = null;
  let renewal: (() => void) | undefined;
  let renewalCancelled = false;
  const terminalIntents = new Map<string, LifecycleTerminalIntentV1>();
  const terminalOwnerships: DatabaseOperationOwnershipV1[] = [];
  const globalAdmission = {
    async acquire(lease: { sessionId: string; generation: string }) {
      if (activeLease !== null) return false;
      activeLease = `${lease.sessionId}_${lease.generation}`;
      return true;
    },
    async renew() {
      activeLease = null;
      return false;
    },
    async release() {
      activeLease = null;
    },
  };
  const service = createLifecycleAdmission({
    globalAdmission,
    project: async (holderId) => ({
      projection: { revisionNumber: 1 },
      projectionSha256: 'a'.repeat(64),
      hold: { boardPk: 50n, revisionPk: 60n, holderId },
    }),
    runtime: {
      now: () => 1_000,
      scheduleInterval(operation) {
        renewal = operation;
        return () => {
          renewalCancelled = true;
        };
      },
      wait: async () => undefined,
    },
    terminalIntents,
    terminalOwnerships,
  });
  const lease = await service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'renewal_loss_fixture',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120_000,
  });
  await lease.auditCompleted(10);
  renewal?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lease.ownershipSignal.aborted, true);
  assert.throws(
    () => lease.assertOwnership(),
    (error: unknown) =>
      error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDERER_UNAVAILABLE',
  );
  assert.equal(renewalCancelled, true);
  await assert.rejects(
    service.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: 'renewal_loss_replacement',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 120_000,
    }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
  );
  await lease.auditFailed('EXPORT_RENDERER_UNAVAILABLE');
  assert.deepEqual(terminalIntents.get('renewal_loss_fixture'), {
    outcome: 'failed',
    reason: 'EXPORT_RENDERER_UNAVAILABLE',
  });
  assert.equal(terminalOwnerships.length, 2);
  assert.equal(terminalOwnerships[0], terminalOwnerships[1]);
  assert.equal(terminalOwnerships[0]?.signal.aborted, false);
  await lease.abort();
  const replacement = await service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'renewal_loss_reconciled',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120_000,
  });
  await replacement.abort();
});

test('known failed terminal outcomes outlive caller abort and the original deadline', async () => {
  const scenarios = ['caller-abort', 'expired-deadline'] as const;
  for (const scenario of scenarios) {
    const terminalIntents = new Map<string, LifecycleTerminalIntentV1>();
    const terminalOwnerships: DatabaseOperationOwnershipV1[] = [];
    const controller = new AbortController();
    const deadlineMs = Date.now() + 100;
    const service = createLifecycleAdmission({
      globalAdmission: {
        async acquire() {
          return true;
        },
        async renew() {
          return true;
        },
        async release() {},
      },
      project: async (holderId) => ({
        projection: { revisionNumber: 1 },
        projectionSha256: 'a'.repeat(64),
        hold: { boardPk: 50n, revisionPk: 60n, holderId },
      }),
      runtime: {
        now: () => Date.now(),
        scheduleInterval: () => () => undefined,
        wait: async () => undefined,
      },
      terminalIntents,
      terminalOwnerships,
    });
    const correlationId = `terminal_cleanup_${scenario}`;
    const lease = await service.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId,
      signal: controller.signal,
      deadlineMs,
    });
    if (scenario === 'caller-abort') controller.abort();
    else
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, deadlineMs - Date.now() + 5)));

    await lease.auditFailed('EXPORT_ENCODE_FAILED');
    assert.deepEqual(terminalIntents.get(correlationId), {
      outcome: 'failed',
      reason: 'EXPORT_ENCODE_FAILED',
    });
    assert.equal(terminalOwnerships.length, 2);
    assert.equal(terminalOwnerships[0], terminalOwnerships[1]);
    assert.notEqual(terminalOwnerships[0]?.signal, controller.signal);
    assert.equal(terminalOwnerships[0]?.signal.aborted, false);
    assert.ok((terminalOwnerships[0]?.deadlineMs ?? 0) > deadlineMs);
    await lease.abort();
  }
});

test('known completed terminal outcome uses cleanup ownership after caller finish', async () => {
  const terminalIntents = new Map<string, LifecycleTerminalIntentV1>();
  const terminalOwnerships: DatabaseOperationOwnershipV1[] = [];
  const controller = new AbortController();
  const service = createLifecycleAdmission({
    globalAdmission: {
      async acquire() {
        return true;
      },
      async renew() {
        return true;
      },
      async release() {},
    },
    project: async (holderId) => ({
      projection: { revisionNumber: 1 },
      projectionSha256: 'a'.repeat(64),
      hold: { boardPk: 50n, revisionPk: 60n, holderId },
    }),
    runtime: {
      now: () => Date.now(),
      scheduleInterval: () => () => undefined,
      wait: async () => undefined,
    },
    terminalIntents,
    terminalOwnerships,
  });
  const lease = await service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'terminal_cleanup_completed',
    signal: controller.signal,
    deadlineMs: Date.now() + 120_000,
  });
  await lease.auditCompleted(42);
  controller.abort();
  await lease.completeResponse();
  assert.deepEqual(terminalIntents.get('terminal_cleanup_completed'), {
    outcome: 'completed',
    bytes: 42,
  });
  assert.equal(terminalOwnerships.length, 2);
  assert.equal(terminalOwnerships[0], terminalOwnerships[1]);
  assert.equal(terminalOwnerships[0]?.signal.aborted, false);
});

test('known terminal outcomes retry finalization after response cleanup grace', async () => {
  const scenarios = [
    {
      outcome: 'completed' as const,
      correlationId: 'terminal_retry_completed',
      expected: { outcome: 'completed' as const, bytes: 42 },
    },
    {
      outcome: 'failed' as const,
      correlationId: 'terminal_retry_failed',
      expected: { outcome: 'failed' as const, reason: 'EXPORT_ENCODE_FAILED' },
    },
  ];
  for (const scenario of scenarios) {
    const terminalIntents = new Map<string, LifecycleTerminalIntentV1>();
    const terminalOwnerships: DatabaseOperationOwnershipV1[] = [];
    let databaseAvailable = false;
    let releaseBlockedConnection: (() => void) | undefined;
    const blockedConnection = new Promise<void>((resolve) => {
      releaseBlockedConnection = resolve;
    });
    let releaseRetryWait: (() => void) | undefined;
    let retryWaitCalls = 0;
    const retryWait = new Promise<void>((resolve) => {
      releaseRetryWait = resolve;
    });
    let persistedCalls = 0;
    let terminalPersisted: (() => void) | undefined;
    const terminalPersistence = new Promise<void>((resolve) => {
      terminalPersisted = resolve;
    });
    const service = createLifecycleAdmission({
      globalAdmission: {
        async acquire() {
          return true;
        },
        async renew() {
          return true;
        },
        async release() {},
      },
      project: async (holderId) => ({
        projection: { revisionNumber: 1 },
        projectionSha256: 'a'.repeat(64),
        hold: { boardPk: 50n, revisionPk: 60n, holderId },
      }),
      runtime: {
        now: () => Date.now(),
        scheduleInterval: () => () => undefined,
        wait: async () => {
          retryWaitCalls += 1;
          await retryWait;
        },
      },
      terminalIntents,
      terminalOwnerships,
      beforeTerminalConnection: async () => {
        if (!databaseAvailable) await blockedConnection;
      },
      onTerminalPersisted: (correlationId, outcome) => {
        assert.equal(correlationId, scenario.correlationId);
        assert.equal(outcome, scenario.outcome);
        persistedCalls += 1;
        terminalPersisted?.();
      },
    });
    const lease = await service.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: scenario.correlationId,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 120_000,
    });
    let backgroundAudit: Promise<void> | undefined;
    if (scenario.outcome === 'completed') await lease.auditCompleted(42);
    else {
      backgroundAudit = lease.auditFailed('EXPORT_ENCODE_FAILED');
      void backgroundAudit.catch(() => undefined);
    }

    await assert.rejects(
      scenario.outcome === 'completed' ? lease.completeResponse() : lease.abort(),
    );
    if (backgroundAudit !== undefined) await assert.rejects(backgroundAudit);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retryWaitCalls, 1);
    assert.deepEqual(terminalIntents.get(scenario.correlationId), { outcome: 'pending' });

    databaseAvailable = true;
    releaseBlockedConnection?.();
    releaseRetryWait?.();
    await terminalPersistence;
    if (scenario.outcome === 'failed') await lease.auditFailed('EXPORT_ENCODE_FAILED');
    assert.deepEqual(terminalIntents.get(scenario.correlationId), scenario.expected);
    assert.equal(persistedCalls, 1);
    assert.equal(terminalOwnerships.length, 3);
    assert.notEqual(terminalOwnerships[0], terminalOwnerships[1]);
    assert.equal(terminalOwnerships[1], terminalOwnerships[2]);
    assert.equal(
      terminalOwnerships.every(({ signal }) => !signal.aborted),
      true,
    );
  }
});

test('terminal reservation failure rolls back without scheduling finalization', async () => {
  const probe = createRolledBackReservationProbe({
    beforeTerminalReserve: async () => {
      throw new Error('fixture terminal reservation failure');
    },
  });
  await assert.rejects(
    probe.service.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: 'terminal_reservation_rollback',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 120_000,
    }),
    /fixture terminal reservation failure/u,
  );
  assert.equal(probe.terminalIntents.has('terminal_reservation_rollback'), false);
  assert.deepEqual(probe.observations, { finalizeAttempts: 0, retryWaits: 0 });
});

test('post-reserve authorization rollback does not schedule finalization', async () => {
  const probe = createRolledBackReservationProbe({
    afterAuthorizationApply: async () => {
      throw new Error('fixture post-reserve authorization rejection');
    },
  });
  await assert.rejects(
    probe.service.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: 'terminal_post_reserve_rollback',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 120_000,
    }),
    /fixture post-reserve authorization rejection/u,
  );
  assert.equal(probe.terminalIntents.has('terminal_post_reserve_rollback'), false);
  assert.deepEqual(probe.observations, { finalizeAttempts: 0, retryWaits: 0 });
});

test('detached authorization rejection after rollback does not schedule finalization', async () => {
  let authorizationApplied: (() => void) | undefined;
  const authorizationApply = new Promise<void>((resolve) => {
    authorizationApplied = resolve;
  });
  let rejectAuthorization: (() => void) | undefined;
  const authorizationRelease = new Promise<void>((resolve) => {
    rejectAuthorization = resolve;
  });
  let authorizationRolledBack: (() => void) | undefined;
  const authorizationRollback = new Promise<void>((resolve) => {
    authorizationRolledBack = resolve;
  });
  const probe = createRolledBackReservationProbe({
    afterAuthorizationApply: async () => {
      authorizationApplied?.();
      await authorizationRelease;
      throw new Error('fixture detached authorization rejection');
    },
    onAuthorizationRollback: () => authorizationRolledBack?.(),
  });
  const controller = new AbortController();
  const admission = probe.service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'terminal_detached_rollback',
    signal: controller.signal,
    deadlineMs: Date.now() + 120_000,
  });
  await authorizationApply;
  controller.abort();
  await assert.rejects(
    admission,
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
  );
  rejectAuthorization?.();
  await authorizationRollback;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probe.terminalIntents.has('terminal_detached_rollback'), false);
  assert.deepEqual(probe.observations, { finalizeAttempts: 0, retryWaits: 0 });
});

test('terminal audit retry backs off after finalized persistence failure', async () => {
  const terminalIntents = new Map<string, LifecycleTerminalIntentV1>();
  let persistAttempts = 0;
  let retryWaitCalls = 0;
  let releaseRetryWait: (() => void) | undefined;
  const retryWait = new Promise<void>((resolve) => {
    releaseRetryWait = resolve;
  });
  let terminalPersisted: (() => void) | undefined;
  const terminalPersistence = new Promise<void>((resolve) => {
    terminalPersisted = resolve;
  });
  const service = createLifecycleAdmission({
    globalAdmission: {
      async acquire() {
        return true;
      },
      async renew() {
        return true;
      },
      async release() {},
    },
    project: async (holderId) => ({
      projection: { revisionNumber: 1 },
      projectionSha256: 'a'.repeat(64),
      hold: { boardPk: 50n, revisionPk: 60n, holderId },
    }),
    runtime: {
      now: () => Date.now(),
      scheduleInterval: () => () => undefined,
      wait: async () => {
        retryWaitCalls += 1;
        await retryWait;
      },
    },
    terminalIntents,
    beforeTerminalPersist: async () => {
      persistAttempts += 1;
      if (persistAttempts === 1) throw new Error('fixture terminal persistence failure');
    },
    onTerminalPersisted: () => terminalPersisted?.(),
  });
  const lease = await service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'terminal_persist_retry_backoff',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120_000,
  });
  await assert.rejects(lease.auditFailed('EXPORT_ENCODE_FAILED'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryWaitCalls, 1);
  assert.equal(persistAttempts, 1);
  releaseRetryWait?.();
  await terminalPersistence;
  assert.equal(persistAttempts, 2);
  assert.deepEqual(terminalIntents.get('terminal_persist_retry_backoff'), {
    outcome: 'failed',
    reason: 'EXPORT_ENCODE_FAILED',
  });
  await lease.abort();
});

test('persistent global release failure stops renewal and retains local ownership until expiry', async () => {
  let nowMs = 10_000;
  let scheduledRenewal: (() => void) | undefined;
  let renewalCancelled = false;
  let waitResolved: (() => void) | undefined;
  const releaseKeys: string[] = [];
  let renewCalls = 0;
  let releaseFails = true;
  const activeLeases = new Map<string, number>();
  const globalAdmission = {
    async acquire(lease: { sessionId: string; generation: string }) {
      for (const [holderId, expiresAt] of activeLeases) {
        if (expiresAt <= nowMs) activeLeases.delete(holderId);
      }
      if (activeLeases.size >= 1) return false;
      activeLeases.set(`${lease.sessionId}_${lease.generation}`, nowMs + EXPORT_GLOBAL_LEASE_MS_V1);
      return true;
    },
    async renew() {
      renewCalls += 1;
      return true;
    },
    async release(lease: { sessionId: string; generation: string }) {
      const holderId = `${lease.sessionId}_${lease.generation}`;
      releaseKeys.push(holderId);
      if (releaseFails) throw new Error('persistent Redis release failure');
      activeLeases.delete(holderId);
    },
  };
  const service = createLifecycleAdmission({
    globalAdmission,
    project: async (holderId) => ({
      projection: { revisionNumber: 1 },
      projectionSha256: 'a'.repeat(64),
      hold: { boardPk: 50n, revisionPk: 60n, holderId },
    }),
    runtime: {
      now: () => nowMs,
      scheduleInterval(operation) {
        scheduledRenewal = operation;
        return () => {
          renewalCancelled = true;
        };
      },
      wait: () =>
        new Promise<void>((resolve) => {
          waitResolved = resolve;
        }),
    },
  });
  const lease = await service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'persistent_release_fixture',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120_000,
  });
  const firstCleanup = lease.abort();
  const secondCleanup = lease.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewalCancelled, true);
  assert.equal(releaseKeys.length, 2);
  await assert.rejects(
    service.admit({
      principal: lifecyclePrincipal(),
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: 'persistent_release_replacement',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 120_000,
    }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
  );
  nowMs += EXPORT_GLOBAL_LEASE_MS_V1 + 1;
  waitResolved?.();
  await Promise.all([firstCleanup, secondCleanup]);
  const oldReleaseKeys = [...releaseKeys];
  releaseFails = false;
  scheduledRenewal?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewCalls, 0);
  assert.equal(new Set(oldReleaseKeys).size, 1);
  const replacement = await service.admit({
    principal: lifecyclePrincipal(),
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'persistent_release_reconciled',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120_000,
  });
  await replacement.abort();
});

test('revision holds reject and cannot be renewed or released by a colliding generation', async () => {
  let activeHolder: string | null = null;
  const connection = {
    async execute(sql: string, parameters: readonly string[]) {
      if (sql.includes('SELECT holder_id AS holderId'))
        return [activeHolder === null ? [] : [{ holderId: activeHolder }], []];
      const holderId = parameters[2] ?? '';
      if (sql.includes('INSERT INTO board_revision_holds')) {
        activeHolder = holderId;
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SET expires_at'))
        return [{ affectedRows: holderId === activeHolder ? 1 : 0 }, []];
      if (sql.includes('SET released_at')) {
        const owned = holderId === activeHolder;
        if (owned) activeHolder = null;
        return [{ affectedRows: owned ? 1 : 0 }, []];
      }
      throw new Error('unexpected hold SQL');
    },
  } as unknown as PoolConnection;
  const holds = new ExportRevisionHoldRepositoryV1();
  const older = {
    boardPk: 1n,
    revisionPk: 2n,
    holderId: `${sessionId}_${'X'.repeat(22)}`,
  };
  const newer = { ...older, holderId: `${sessionId}_${'Y'.repeat(22)}` };
  await holds.acquire(connection, older);
  await assert.rejects(holds.acquire(connection, newer), ExportRevisionHoldConflictV1);
  await assert.rejects(holds.renew(connection, newer), ExportRevisionHoldConflictV1);
  assert.equal(await holds.release(connection, newer), false);
  await holds.renew(connection, older);
  assert.equal(await holds.release(connection, older), true);
});

test('global admission rejects an authorized fifth request before projection or started audit', async () => {
  let projectionCalls = 0;
  let startedAuditCalls = 0;
  let globalAcquireCalls = 0;
  const connection = {
    async execute() {
      return [[{ boardPk: '50', ownerUserPk: '20', title: 'Board' }], []];
    },
  };
  const service = new ExportAdmissionServiceV1(
    {
      async authorize(input: {
        apply: (connection: unknown, context: { ownerUserPk: bigint }) => Promise<unknown>;
      }) {
        return input.apply(connection, { ownerUserPk: 20n });
      },
    } as never,
    {
      async project() {
        projectionCalls += 1;
        throw new Error('projection must not run when fleet capacity is full');
      },
    } as never,
    {
      issueCredentials: () => ({ sessionId, token }),
      async cancel() {},
    } as never,
    { async dispose() {} } as never,
    {} as never,
    {
      async acquire() {
        globalAcquireCalls += 1;
        return false;
      },
      async release() {
        throw new Error('a rejected global lease must not be released');
      },
    } as never,
    {} as never,
    {
      async started() {
        startedAuditCalls += 1;
      },
    } as never,
    {} as never,
    {
      withConnection: async <T>(work: (value: typeof connection) => Promise<T>) => work(connection),
    } as unknown as MysqlService,
    {
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3410',
      artifactRuntimeOrigin: 'http://127.0.0.2:3412',
    },
  );
  await assert.rejects(
    service.admit({
      principal: {
        kind: 'account_api_key',
        actor: {
          principalKind: 'service',
          principalId: 'key_fixture',
          grantId: null,
          scopes: ['export:read'],
        },
        ownerUserPk: 20n,
        apiKeyPk: 70n,
        scopeMask: 32,
        isBrowserCredential: false,
      } as unknown as ResolvedBoardPrincipalV1,
      boardId: exportBoardId,
      request: { format: 'pdf', revisionId: null },
      correlationId: 'capacity_fixture',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
  );
  assert.equal(globalAcquireCalls, 1);
  assert.equal(projectionCalls, 0);
  assert.equal(startedAuditCalls, 0);
});

test('delivered export outcome remains completed across audit and hold cleanup failures', async () => {
  const auditEvents: string[] = [];
  let completedAttempts = 0;
  let holdReleaseAttempts = 0;
  let globalReleaseAttempts = 0;
  const connection = {
    async execute() {
      return [[{ boardPk: '50', ownerUserPk: '20', title: 'Board' }], []];
    },
  };
  const audit = {
    async started() {
      auditEvents.push('started');
    },
    async completed(_connection: unknown, input: { bytes: number }) {
      completedAttempts += 1;
      if (completedAttempts === 1) throw new Error('fixture terminal audit failure');
      auditEvents.push(`completed:${input.bytes}`);
    },
    async failed(_connection: unknown, input: { reason: string }) {
      auditEvents.push(`failed:${input.reason}`);
    },
  };
  let terminalIntent:
    | { outcome: 'completed'; bytes: number }
    | { outcome: 'failed'; reason: string }
    | undefined;
  let terminalReserved = false;
  let terminalPersisted = false;
  const terminalAudits = {
    async reserve() {
      terminalReserved = true;
      return terminalIntent?.outcome ?? 'pending';
    },
    async finalize(_connection: unknown, input: typeof terminalIntent & { correlationId: string }) {
      if (!terminalReserved) throw new Error('fixture terminal reservation missing');
      terminalIntent ??= input;
      return terminalIntent!.outcome;
    },
    async persist() {
      if (terminalPersisted) return false;
      if (terminalIntent === undefined) throw new Error('fixture terminal intent missing');
      if (terminalIntent.outcome === 'completed')
        await audit.completed(connection, { bytes: terminalIntent.bytes });
      else await audit.failed(connection, { reason: terminalIntent.reason });
      terminalPersisted = true;
      return true;
    },
  };
  const service = new ExportAdmissionServiceV1(
    {
      async authorize(input: {
        apply: (connection: unknown, context: { ownerUserPk: bigint }) => Promise<unknown>;
      }) {
        return input.apply(connection, { ownerUserPk: 20n });
      },
    } as never,
    {
      async project() {
        return {
          projection: { revisionNumber: 1 },
          projectionSha256: 'a'.repeat(64),
          hold: { boardPk: 50n, revisionPk: 60n, holderId: sessionId },
        };
      },
    } as never,
    {
      issueCredentials: () => ({ sessionId, token }),
      async open() {},
      async cancel() {},
    } as never,
    { register() {}, async dispose() {} } as never,
    {
      async render() {
        return {
          projection: { revisionNumber: 1 },
          async completeResponse() {
            holdReleaseAttempts += 1;
            if (holdReleaseAttempts === 1) throw new Error('fixture hold cleanup failure');
          },
          async abort() {
            throw new Error('completion must not be relabeled as aborted');
          },
        };
      },
    } as never,
    {
      async acquire() {
        return true;
      },
      async release() {
        globalReleaseAttempts += 1;
      },
    } as never,
    { async renew() {}, async release() {} } as never,
    audit as never,
    terminalAudits as never,
    {
      withConnection: async <T>(work: (value: typeof connection) => Promise<T>) => work(connection),
    } as unknown as MysqlService,
    {
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3410',
      artifactRuntimeOrigin: 'http://127.0.0.2:3412',
    },
  );
  const lease = await service.admit({
    principal: {
      kind: 'account_api_key',
      actor: {
        principalKind: 'service',
        principalId: 'key_fixture',
        grantId: null,
        scopes: ['export:read'],
      },
      ownerUserPk: 20n,
      apiKeyPk: 70n,
      scopeMask: 32,
      isBrowserCredential: false,
    } as unknown as ResolvedBoardPrincipalV1,
    boardId: exportBoardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'terminal_fixture',
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
  });
  await lease.auditCompleted(123);
  await assert.rejects(lease.completeResponse());
  await lease.auditFailed('EXPORT_ENCODE_FAILED');
  await lease.completeResponse();
  assert.deepEqual(auditEvents, ['started', 'completed:123']);
  assert.equal(completedAttempts, 2);
  assert.equal(holdReleaseAttempts, 2);
  assert.equal(globalReleaseAttempts, 1);
});

test('malformed outbox candidate identity is quarantined while a healthy sibling progresses', async () => {
  const healthyEventId = '33333333-3333-4333-8333-333333333333';
  const boardId = '11111111-1111-4111-8111-111111111111' as BoardId;
  const candidateRows = [
    { eventPk: '1', eventId: Buffer.alloc(16) },
    { eventPk: '2', eventId: Buffer.from(parsePublicUuidV4(healthyEventId)) },
  ];
  const connection = {
    async query(sql: string) {
      if (sql.includes('AS oldestPendingAgeMs')) return [[{ oldestPendingAgeMs: '1' }], []];
      if (sql.includes('FROM board_event_outbox FORCE INDEX')) return [candidateRows, []];
      throw new Error('unexpected outbox SQL');
    },
  };
  const mysql = {
    withConnection: async <T>(work: (value: typeof connection) => Promise<T>) => work(connection),
  } as unknown as MysqlService;
  const repository = new BoardEventOutboxRepository(mysql);
  const marked: bigint[] = [];
  const published: string[] = [];
  const delivery = {
    listPendingCandidates: (limit: number) => repository.listPendingCandidates(limit),
    async loadPendingEvent(candidate: { eventPk: bigint; eventId: string }) {
      return {
        eventPk: candidate.eventPk,
        eventId: candidate.eventId,
        boardId,
        sequence: 1,
      };
    },
    async markDelivered(eventPk: bigint) {
      marked.push(eventPk);
      return true;
    },
  };
  const dispatcher = new OutboxDispatcherService(
    delivery as never,
    {
      async tryAcquireLease() {
        return true;
      },
      async publish(_channel: string, message: string) {
        published.push(message);
        return 0;
      },
    } as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 9)),
  );
  assert.deepEqual(await dispatcher.dispatchOnce(), {
    candidates: 1,
    leaseWins: 1,
    published: 1,
    markedDelivered: 1,
    failures: 0,
  });
  assert.deepEqual(marked, [2n]);
  assert.equal(published.length, 1);
  assert.equal((await repository.getHealth()).quarantinedCorruptPending, true);

  const restarted = new BoardEventOutboxRepository(mysql);
  assert.deepEqual(await restarted.listPendingCandidates(), [
    { eventPk: 2n, eventId: healthyEventId },
  ]);
  assert.equal((await restarted.getHealth()).quarantinedCorruptPending, true);
});

const exportBoardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const exportRevisionId = '00112233-4455-4677-8899-aabbccddeeff' as RevisionId;

const exportDocument = (roots: readonly unknown[]): BoardDocumentV3 =>
  ({
    schemaVersion: 3,
    format: 'wide_16_9',
    defaultPageId: 'page_1',
    pages: roots.map((root, index) => ({
      pageId: `page_${index + 1}`,
      title: '',
      displayMode: 'fit-page',
      scene: { protocolVersion: 1, type: 'scene', root },
    })),
  }) as unknown as BoardDocumentV3;

const artifactNode = (id: string, type: 'A' | 'I') =>
  type === 'A'
    ? {
        id,
        type: 'content.artifact',
        artifact: { artifactId: 'asset_1', versionId: 'version_1' },
        fallbackText: '',
      }
    : {
        id,
        type: 'content.image',
        source: {
          type: 'artifact.resource',
          artifact: { artifactId: 'asset_1', versionId: 'version_1' },
          path: 'image.png',
          sha256: 'a'.repeat(64),
        },
        alt: '',
        fit: 'contain',
      };

const mediaNode = (id: string, mediaId = 'media_1') => ({
  id,
  type: 'content.image',
  source: { type: 'media', mediaId },
  alt: '',
  fit: 'contain',
});

const output = () => ({
  descriptors: new Map<string, ExportProjectionResourceV1>(),
  bytes: new Map<string, { mediaType: string; bytes: Buffer }>(),
});

const projectionConnection = (input: {
  mediaReferences?: readonly unknown[];
  mediaInventory?: readonly unknown[];
  mediaResources?: readonly unknown[];
  artifactReferences?: readonly unknown[];
  payloadQueries?: string[];
}): PoolConnection =>
  ({
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      if (normalized.includes('FROM board_revision_artifact_refs'))
        return [input.artifactReferences ?? [], []];
      if (normalized.includes('JOIN board_media')) {
        if (normalized.includes('o.bytes')) {
          input.payloadQueries?.push(normalized);
          return [input.mediaResources ?? [], []];
        }
        return [
          input.mediaInventory ??
            (input.mediaResources ?? []).map((resource) => {
              if (resource === null || typeof resource !== 'object') return resource;
              const { bytes: _bytes, ...metadata } = resource as Record<string, unknown>;
              return metadata;
            }),
          [],
        ];
      }
      if (normalized.includes('FROM board_revision_media_refs'))
        return [input.mediaReferences ?? [], []];
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  }) as unknown as PoolConnection;

const projectionProbe = (packageReads: string[] = []) => {
  const service = new ExportProjectionServiceV1(
    new DocumentCheckpointCodec(),
    {
      readImmutablePackage: async (
        _connection: PoolConnection,
        _boardId: string,
        artifact: { artifactId: string; versionId: string },
      ) => {
        packageReads.push(`${artifact.artifactId}:${artifact.versionId}`);
        return { manifestBytes: Buffer.from('{}'), resources: [] };
      },
    } as never,
    {} as never,
    [],
  );
  return service as unknown as {
    addMediaResources(
      connection: PoolConnection,
      revisionPk: bigint,
      boardId: BoardId,
      document: BoardDocumentV3,
      revisionId: RevisionId,
      sessionId: string,
      output: unknown,
    ): Promise<void>;
    addArtifactResources(
      connection: PoolConnection,
      revisionPk: bigint,
      boardId: BoardId,
      document: BoardDocumentV3,
      revisionId: RevisionId,
      sessionId: string,
      output: unknown,
    ): Promise<void>;
    sealBundle(
      projection: ImmutableExportProjectionV1,
      resources: unknown,
      hold: { boardPk: bigint; revisionPk: bigint; holderId: string },
    ): ExportProjectionBundleV1;
  };
};

const requiredContentFailure = (error: unknown): boolean =>
  error instanceof ExportFailureV1 && error.code === 'EXPORT_REQUIRED_CONTENT_UNSUPPORTED';

const boundsFailure = (error: unknown): boolean =>
  error instanceof ExportFailureV1 && error.code === 'EXPORT_BOUNDS_EXCEEDED';

test('export accepts empty derived inventories and deduplicates repeated media', async () => {
  const probe = projectionProbe();
  const empty = exportDocument([null]);
  const emptyOutput = output();
  const emptyConnection = projectionConnection({});
  await probe.addMediaResources(
    emptyConnection,
    1n,
    exportBoardId,
    empty,
    exportRevisionId,
    sessionId,
    emptyOutput,
  );
  await probe.addArtifactResources(
    emptyConnection,
    1n,
    exportBoardId,
    empty,
    exportRevisionId,
    sessionId,
    emptyOutput,
  );
  assert.equal(emptyOutput.descriptors.size, 0);

  const bytes = Buffer.from('image');
  const mediaId = Buffer.from('media_1', 'ascii');
  const repeated = exportDocument([mediaNode('media_node_1'), mediaNode('media_node_2')]);
  const repeatedOutput = output();
  await probe.addMediaResources(
    projectionConnection({
      mediaReferences: [{ mediaId, firstPageId: Buffer.from('page_1', 'ascii'), ordinal: 1 }],
      mediaResources: [
        {
          mediaId,
          ordinal: 1,
          mediaType: 'image/png',
          bytes,
          byteLength: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest(),
        },
      ],
    }),
    1n,
    exportBoardId,
    repeated,
    exportRevisionId,
    sessionId,
    repeatedOutput,
  );
  assert.deepEqual(
    [...repeatedOutput.descriptors.values()].map((descriptor) => descriptor.usage),
    [{ kind: 'media', mediaId: 'media_1' }],
  );
});

test('sealed projection ownership isolates nested state, maps, and canonical buffers', () => {
  const bytes = Buffer.from('immutable-resource');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const descriptor: ExportProjectionResourceV1 = {
    sha256: digest,
    mediaType: 'image/png',
    byteLength: bytes.byteLength,
    url: `/internal/v1/export-render/${sessionId}/resources/${digest}`,
    usage: { kind: 'media', mediaId: 'media_1' },
  };
  const projection = {
    schemaVersion: 1,
    boardId: exportBoardId,
    revisionId: exportRevisionId,
    revisionNumber: 1,
    document: exportDocument([mediaNode('media_node_1')]),
    format: { width: 16, height: 9, unit: 'ratio' },
    resources: [descriptor],
  } as unknown as ImmutableExportProjectionV1;
  const resources = output();
  resources.descriptors.set('media:media_1', descriptor);
  resources.bytes.set(digest, { mediaType: 'image/png', bytes });
  const bundle = projectionProbe().sealBundle(projection, resources, {
    boardPk: 1n,
    revisionPk: 2n,
    holderId: `${sessionId}_${'X'.repeat(22)}`,
  });

  (projection.document.pages[0] as { title: string }).title = 'mutated source';
  (descriptor.usage as { mediaId: string }).mediaId = 'mutated_source';
  assert.equal(bundle.projection.document.pages[0]?.title, '');
  assert.deepEqual(bundle.projection.resources[0]?.usage, { kind: 'media', mediaId: 'media_1' });
  assert.throws(() => {
    (bundle.projection.document.pages[0] as { title: string }).title = 'mutated bundle';
  }, TypeError);
  assert.throws(() => {
    (bundle.projection.resources[0]?.usage as { mediaId: string }).mediaId = 'mutated_bundle';
  }, TypeError);

  const firstProjectionBytes = bundle.projectionBytes;
  const canonicalProjectionBytes = Buffer.from(firstProjectionBytes);
  firstProjectionBytes.fill(0);
  assert.deepEqual(bundle.projectionBytes, canonicalProjectionBytes);
  assert.equal(
    createHash('sha256').update(bundle.projectionBytes).digest('hex'),
    bundle.projectionSha256,
  );

  const firstResourceBytes = bundle.resourceBytes.get(digest);
  assert.ok(firstResourceBytes !== undefined);
  firstResourceBytes.fill(0);
  assert.deepEqual(bundle.resourceBytes.get(digest), bytes);
  assert.throws(() =>
    (bundle.resourceBytes as unknown as Map<string, Buffer>).set(digest, Buffer.from('replace')),
  );
  assert.throws(() => (bundle.resourceBytes as unknown as Map<string, Buffer>).delete(digest));
  assert.deepEqual(bundle.resourceBytes.get(digest), bytes);
});

test('media bounds are certified from metadata before any payload query', async () => {
  const probe = projectionProbe();
  const scenario = (count: number, byteLength: (index: number) => number) => {
    const mediaReferences = Array.from({ length: count }, (_, index) => ({
      mediaId: Buffer.from(`media_${index.toString()}`, 'ascii'),
      firstPageId: Buffer.from(`page_${(index + 1).toString()}`, 'ascii'),
      ordinal: index + 1,
    }));
    const mediaInventory = mediaReferences.map((reference, index) => ({
      mediaId: reference.mediaId,
      ordinal: reference.ordinal,
      mediaType: 'image/png',
      byteLength: byteLength(index),
      sha256: Buffer.alloc(32, (index % 255) + 1),
    }));
    return {
      document: exportDocument(
        mediaReferences.map((_, index) =>
          mediaNode(`media_node_${index.toString()}`, `media_${index.toString()}`),
        ),
      ),
      mediaReferences,
      mediaInventory,
    };
  };
  for (const bounded of [
    scenario(EXPORT_RESOURCE_MAX_COUNT_V1 + 1, () => 1),
    scenario(1, () => EXPORT_RESOURCE_MAX_BYTES_V1 + 1),
    scenario(17, () => Math.ceil(EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1 / 16)),
  ]) {
    const payloadQueries: string[] = [];
    await assert.rejects(
      probe.addMediaResources(
        projectionConnection({
          mediaReferences: bounded.mediaReferences,
          mediaInventory: bounded.mediaInventory,
          payloadQueries,
        }),
        1n,
        exportBoardId,
        bounded.document,
        exportRevisionId,
        sessionId,
        output(),
      ),
      boundsFailure,
    );
    assert.deepEqual(payloadQueries, []);
  }
});

test('export fails closed for incomplete, inactive, malformed, or misordered media rows', async () => {
  const probe = projectionProbe();
  const document = exportDocument([mediaNode('media_node_1'), mediaNode('media_node_2')]);
  const bytes = Buffer.from('image');
  const exactReference = {
    mediaId: Buffer.from('media_1', 'ascii'),
    firstPageId: Buffer.from('page_1', 'ascii'),
    ordinal: 1,
  };
  const exactResource = {
    mediaId: Buffer.from('media_1', 'ascii'),
    ordinal: 1,
    mediaType: 'image/png',
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest(),
  };
  for (const scenario of [
    { name: 'missing', mediaReferences: [], mediaResources: [exactResource] },
    {
      name: 'extra',
      mediaReferences: [
        exactReference,
        {
          mediaId: Buffer.from('media_2', 'ascii'),
          firstPageId: Buffer.from('page_2', 'ascii'),
          ordinal: 2,
        },
      ],
      mediaResources: [exactResource],
    },
    {
      name: 'malformed identifier',
      mediaReferences: [{ ...exactReference, mediaId: Buffer.from([0xff]) }],
      mediaResources: [exactResource],
    },
    {
      name: 'wrong first page',
      mediaReferences: [{ ...exactReference, firstPageId: Buffer.from('page_2', 'ascii') }],
      mediaResources: [exactResource],
    },
    {
      name: 'wrong ordinal',
      mediaReferences: [{ ...exactReference, ordinal: 2 }],
      mediaResources: [exactResource],
    },
    {
      name: 'inactive or quarantined object',
      mediaReferences: [exactReference],
      mediaResources: [],
    },
    {
      name: 'malformed active content',
      mediaReferences: [exactReference],
      mediaResources: [{ ...exactResource, sha256: Buffer.alloc(31) }],
    },
  ]) {
    await assert.rejects(
      probe.addMediaResources(
        projectionConnection(scenario),
        1n,
        exportBoardId,
        document,
        exportRevisionId,
        sessionId,
        output(),
      ),
      requiredContentFailure,
      scenario.name,
    );
  }
});

test('export validates exact A/I occurrence rows before deduplicating one artifact package', async () => {
  const packageReads: string[] = [];
  const probe = projectionProbe(packageReads);
  const document = exportDocument([
    artifactNode('artifact_1', 'A'),
    artifactNode('image_1', 'I'),
    artifactNode('image_2', 'I'),
  ]);
  const artifactReferences = [
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'A',
      occurrenceCount: 1,
    },
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'I',
      occurrenceCount: 2,
    },
  ];
  const resources = output();
  await probe.addArtifactResources(
    projectionConnection({ artifactReferences }),
    1n,
    exportBoardId,
    document,
    exportRevisionId,
    sessionId,
    resources,
  );
  assert.deepEqual(packageReads, ['asset_1:version_1']);
  assert.deepEqual(
    [...resources.descriptors.values()].map((descriptor) => descriptor.usage),
    [{ kind: 'artifact', artifactId: 'asset_1', versionId: 'version_1' }],
  );
});

test('artifact iframe resident-memory admission accepts the page boundary and rejects +1', () => {
  const pageWithArtifacts = (count: number): BoardDocumentV3 =>
    exportDocument([
      {
        id: 'artifact_root',
        type: 'layout.canvas',
        width: 1,
        height: 1,
        children: Array.from({ length: count }, (_, index) => ({
          node: artifactNode(`artifact_${index.toString()}`, 'A'),
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          zIndex: index,
        })),
      },
    ]);
  const descriptor = (byteLength: number): ExportProjectionResourceV1 => ({
    sha256: 'a'.repeat(64),
    mediaType: 'application/vnd.sceneboard.artifact-package+zip',
    byteLength,
    url: `/internal/v1/export-render/${sessionId}/resources/${'a'.repeat(64)}`,
    usage: { kind: 'artifact', artifactId: 'asset_1', versionId: 'version_1' },
  });
  assert.doesNotThrow(() =>
    assertExportArtifactPageResidentMemoryV1(pageWithArtifacts(4), [
      descriptor(EXPORT_ARTIFACT_PAGE_RESIDENT_MAX_BYTES_V1 / 4),
    ]),
  );
  assert.throws(
    () =>
      assertExportArtifactPageResidentMemoryV1(pageWithArtifacts(4), [
        descriptor(EXPORT_ARTIFACT_PAGE_RESIDENT_MAX_BYTES_V1 / 4 + 1),
      ]),
    boundsFailure,
  );
  assert.throws(
    () =>
      assertExportArtifactPageResidentMemoryV1(pageWithArtifacts(500), [descriptor(10_485_760)]),
    boundsFailure,
  );
});

test('export fails closed for missing, extra, malformed, stale, or miscounted A/I rows', async () => {
  const packageReads: string[] = [];
  const probe = projectionProbe(packageReads);
  const document = exportDocument([artifactNode('artifact_1', 'A')]);
  const exact = {
    artifactId: 'asset_1',
    artifactVersionId: 'version_1',
    referenceCode: 'A',
    occurrenceCount: 1,
  };
  for (const scenario of [
    { name: 'missing', artifactReferences: [] },
    {
      name: 'extra',
      artifactReferences: [exact, { ...exact, artifactId: 'asset_2' }],
    },
    { name: 'malformed', artifactReferences: [{ ...exact, referenceCode: 'X' }] },
    { name: 'stale A/I code', artifactReferences: [{ ...exact, referenceCode: 'I' }] },
    { name: 'wrong occurrence', artifactReferences: [{ ...exact, occurrenceCount: 2 }] },
  ]) {
    await assert.rejects(
      probe.addArtifactResources(
        projectionConnection(scenario),
        1n,
        exportBoardId,
        document,
        exportRevisionId,
        sessionId,
        output(),
      ),
      requiredContentFailure,
      scenario.name,
    );
  }
  assert.deepEqual(packageReads, []);
});
