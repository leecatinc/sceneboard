import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { CookieService } from '../../src/auth/cookie.service.js';
import type { SessionService } from '../../src/auth/session.service.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import {
  BoardPrincipalGuard,
  type BoardPrincipalRequest,
} from '../../src/common/guards/board-principal.guard.js';
import type { AppEnvironment } from '../../src/config/env.schema.js';
import type { ActorContextService } from '../../src/grants/actor-context.service.js';
import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';

const KEY = 'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GRANT = 'lcbg_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const accountPrincipal = {
  kind: 'account_api_key',
  actor: {
    principalKind: 'service',
    principalId: 'key_public_1',
    grantId: null,
    scopes: [],
  },
  ownerUserPk: 20n,
  apiKeyPk: 70n,
  scopeMask: 4,
  isBrowserCredential: false,
} as unknown as Extract<ResolvedBoardPrincipalV1, { kind: 'account_api_key' }>;

const executionContext = (request: BoardPrincipalRequest): ExecutionContext =>
  ({
    getHandler: () => 'handler',
    getClass: () => 'controller',
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const setup = (mode: 'standard' | 'media-upload') => {
  const calls: string[] = [];
  const reflector = {
    getAllAndOverride() {
      return mode;
    },
  } as unknown as Reflector;
  const sessions = {
    async resolveShared() {
      calls.push('session');
      throw new Error('unexpected session resolution');
    },
  } as unknown as SessionService;
  const actors = {
    async resolveAccountApiKey(token: string) {
      calls.push(`account:${token}`);
      return accountPrincipal;
    },
    async resolveMcp(value: string) {
      calls.push(`mcp:${value}`);
      return {
        kind: 'mcp',
        isBrowserCredential: false,
      } as ResolvedBoardPrincipalV1;
    },
  } as unknown as ActorContextService;
  const environment = {
    trustedProxyCidrs: [],
  } as unknown as AppEnvironment;
  return {
    calls,
    guard: new BoardPrincipalGuard(
      reflector,
      sessions,
      new CookieService('test'),
      actors,
      environment,
    ),
  };
};

const boardError =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof BoardContractError && error.boardError.code === code;

test('standard admission resolves one API-key bearer and rejects cookie or duplicate ambiguity', async () => {
  const accepted = setup('standard');
  const request: BoardPrincipalRequest = {
    headers: { authorization: `Bearer ${KEY}` },
    rawHeaders: ['Authorization', `Bearer ${KEY}`],
    cookies: {},
    socket: { remoteAddress: '192.0.2.10' },
  };
  assert.equal(await accepted.guard.canActivate(executionContext(request)), true);
  assert.equal(request.boardPrincipal, accountPrincipal);
  assert.deepEqual(accepted.calls, [`account:${KEY}`]);

  for (const ambiguous of [
    {
      headers: {
        authorization: `Bearer ${KEY}`,
        cookie: 'sceneboard_session=session_fixture',
      },
      rawHeaders: [
        'Authorization',
        `Bearer ${KEY}`,
        'Cookie',
        'sceneboard_session=session_fixture',
      ],
      cookies: { sceneboard_session: 'session_fixture' },
    },
    {
      headers: { authorization: `Bearer ${KEY}, Bearer ${GRANT}` },
      rawHeaders: ['Authorization', `Bearer ${KEY}`, 'Authorization', `Bearer ${GRANT}`],
      cookies: {},
    },
  ] satisfies BoardPrincipalRequest[]) {
    const denied = setup('standard');
    await assert.rejects(
      denied.guard.canActivate(executionContext(ambiguous)),
      boardError('UNAUTHENTICATED'),
    );
    assert.deepEqual(denied.calls, []);
  }
});

test('media admission preserves its generic forbidden arms for API keys and browser-shaped bearer requests', async () => {
  for (const request of [
    {
      headers: { authorization: `Bearer ${KEY}` },
      rawHeaders: ['Authorization', `Bearer ${KEY}`],
      cookies: {},
    },
    {
      headers: {
        authorization: `Bearer ${GRANT}`,
        origin: 'https://browser.example',
      },
      rawHeaders: ['Authorization', `Bearer ${GRANT}`, 'Origin', 'https://browser.example'],
      cookies: {},
    },
  ] satisfies BoardPrincipalRequest[]) {
    const denied = setup('media-upload');
    await assert.rejects(
      denied.guard.canActivate(executionContext(request)),
      boardError('FORBIDDEN'),
    );
    assert.deepEqual(denied.calls, []);
  }
});
