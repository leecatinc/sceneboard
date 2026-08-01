import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BoardId } from '@sceneboard/board-schema';

import type { MysqlService } from '../../src/database/mysql.service.js';
import { ExportAdmissionServiceV1 } from '../../src/exports/export-admission.service.js';
import type { ExportAuditServiceV1 } from '../../src/exports/export-audit.service.js';
import type { ExportAuthorizationPolicyV1 } from '../../src/exports/export-authorization.policy.js';
import { ExportFailureV1 } from '../../src/exports/export-errors.js';
import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';

const boardId = 'board_1' as BoardId;

const principal = (keyPk = 70n): ResolvedBoardPrincipalV1 =>
  ({
    kind: 'account_api_key',
    actor: { principalKind: 'service', principalId: `key_${keyPk}`, grantId: null, scopes: [] },
    ownerUserPk: keyPk - 50n,
    apiKeyPk: keyPk,
    scopeMask: 32,
    isBrowserCredential: false,
  }) as unknown as ResolvedBoardPrincipalV1;

const setup = () => {
  let session = 0;
  let authorizationMode: 'success' | 'fail-after-apply' | 'retry-after-apply' = 'success';
  let projectionFailure = false;
  let globalAdmission = true;
  let rendererFailure = false;
  const auditEvents: string[] = [];
  const releaseEvents: string[] = [];
  const connection = {
    async execute() {
      return [[{ boardPk: '50', ownerUserPk: '20', title: 'Board' }], []];
    },
  };
  const authorization = {
    async authorize(input: { apply: (connection: unknown, context: unknown) => Promise<unknown> }) {
      const apply = () => input.apply(connection, { ownerUserPk: 20n });
      if (authorizationMode === 'retry-after-apply') {
        await apply();
        return apply();
      }
      const result = await apply();
      if (authorizationMode === 'fail-after-apply')
        throw new Error('post-apply authorization failed');
      return result;
    },
  } as unknown as ExportAuthorizationPolicyV1;
  const mysql = {
    withConnection: async <T>(work: (value: unknown) => Promise<T>) => work(connection),
  } as unknown as MysqlService;
  const service = new ExportAdmissionServiceV1(
    authorization,
    {
      async project() {
        if (projectionFailure) throw new Error('projection failed');
        return {
          projection: { revisionNumber: 1 },
          projectionSha256: 'a'.repeat(64),
          hold: { boardPk: 50n, revisionPk: 60n },
        };
      },
    } as never,
    {
      issueCredentials() {
        session += 1;
        return { sessionId: `session_${session}`, accessToken: 'fixture' };
      },
      async open() {},
      async cancel() {},
    } as never,
    {
      register() {},
      async dispose() {},
    } as never,
    {
      async render() {
        if (rendererFailure) throw new Error('renderer failed');
        return {
          projection: { revisionNumber: 1 },
          async completeResponse() {
            releaseEvents.push('response:complete');
          },
          async abort() {
            releaseEvents.push('response:abort');
          },
        };
      },
    } as never,
    {
      async acquire() {
        return globalAdmission;
      },
      async release(sessionId: string) {
        releaseEvents.push(`global:${sessionId}`);
      },
    } as never,
    {
      async renew() {},
      async release() {},
    } as never,
    {
      async started() {
        auditEvents.push('started');
      },
      async completed(_connection: unknown, input: { bytes: number }) {
        auditEvents.push(`completed:${input.bytes}`);
      },
      async failed(_connection: unknown, input: { reason: string }) {
        auditEvents.push(`failed:${input.reason}`);
      },
    } as unknown as ExportAuditServiceV1,
    mysql,
    {
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3000',
      artifactRuntimeOrigin: 'http://127.0.0.1:3412',
    },
  );
  return {
    service,
    auditEvents,
    releaseEvents,
    setAuthorizationMode(value: typeof authorizationMode) {
      authorizationMode = value;
    },
    setProjectionFailure(value: boolean) {
      projectionFailure = value;
    },
    setGlobalAdmission(value: boolean) {
      globalAdmission = value;
    },
    setRendererFailure(value: boolean) {
      rendererFailure = value;
    },
  };
};

const admit = (value: ReturnType<typeof setup>, actor = principal()) =>
  value.service.admit({
    principal: actor,
    boardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'request_1',
  });

test('reservation ownership survives post-apply failures and transaction retries', async () => {
  for (const failure of ['fail-after-apply', 'projection', 'global', 'renderer'] as const) {
    const value = setup();
    if (failure === 'fail-after-apply') value.setAuthorizationMode('fail-after-apply');
    if (failure === 'projection') value.setProjectionFailure(true);
    if (failure === 'global') value.setGlobalAdmission(false);
    if (failure === 'renderer') value.setRendererFailure(true);
    await assert.rejects(admit(value));
    value.setAuthorizationMode('success');
    value.setProjectionFailure(false);
    value.setGlobalAdmission(true);
    value.setRendererFailure(false);
    const lease = await admit(value);
    await lease.abort();
  }

  const retried = setup();
  retried.setAuthorizationMode('retry-after-apply');
  const lease = await admit(retried);
  await lease.abort();
});

test('repeated cleanup cannot release a later reservation with the same keys', async () => {
  const value = setup();
  const first = await admit(value);
  await first.abort();
  const second = await admit(value);
  await first.abort();
  await assert.rejects(
    admit(value),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
  );
  await second.abort();
  const third = await admit(value);
  await third.abort();
});

test('completion is audited only after response delivery and terminal audit calls write once', async () => {
  const completed = setup();
  const completedLease = await admit(completed);
  await completedLease.auditCompleted(123);
  assert.equal(completed.auditEvents.includes('completed:123'), false);
  await Promise.all([completedLease.completeResponse(), completedLease.completeResponse()]);
  assert.deepEqual(
    completed.auditEvents.filter((event) => event !== 'started'),
    ['completed:123'],
  );
  await completedLease.auditFailed('EXPORT_ENCODE_FAILED');
  assert.deepEqual(
    completed.auditEvents.filter((event) => event !== 'started'),
    ['completed:123'],
  );

  const failed = setup();
  const failedLease = await admit(failed);
  await failedLease.auditCompleted(456);
  await Promise.all([
    failedLease.auditFailed('EXPORT_ENCODE_FAILED'),
    failedLease.auditFailed('EXPORT_RENDER_TIMEOUT'),
  ]);
  await failedLease.abort();
  assert.deepEqual(
    failed.auditEvents.filter((event) => event !== 'started'),
    ['failed:EXPORT_ENCODE_FAILED'],
  );
});
