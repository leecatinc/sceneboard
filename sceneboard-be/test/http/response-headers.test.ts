import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

import { ResponseHeadersInterceptor } from '../../src/common/http/response-headers.interceptor.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const key = Buffer.alloc(32, 4);
const crypto = new CryptoService(
  {
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  },
  (length) => Buffer.alloc(length, 9),
);

test('sets one safe request ID and auth no-store headers before handler execution', async () => {
  const headers = new Map<string, string>();
  const response = { setHeader: (name: string, value: string) => headers.set(name, value) };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/api/v1/auth/session' }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  const next = { handle: () => of({ ok: true }) } as CallHandler;
  await new Promise<void>((resolve, reject) => {
    new ResponseHeadersInterceptor(crypto)
      .intercept(context, next)
      .subscribe({ complete: resolve, error: reject });
  });
  assert.match(headers.get('X-Request-Id') ?? '', /^[A-Za-z0-9_-]{22}$/);
  assert.equal(headers.get('Cache-Control'), 'no-store, private');
  assert.equal(headers.get('Pragma'), 'no-cache');
});

test('proof-authenticated pairing responses vary on Authorization only', async () => {
  for (const url of [
    '/api/v1/pairings/pairing_1/client-status',
    '/api/v1/pairings/pairing_1/redeem',
  ]) {
    const headers = new Map<string, string>();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => headers.set(name, value),
        }),
      }),
    } as unknown as ExecutionContext;
    const next = { handle: () => of({ ok: true }) } as CallHandler;
    await new Promise<void>((resolve, reject) => {
      new ResponseHeadersInterceptor(crypto)
        .intercept(context, next)
        .subscribe({ complete: resolve, error: reject });
    });
    assert.equal(headers.get('Vary'), 'Authorization');
    assert.equal(headers.get('Cache-Control'), 'no-store, private');
    assert.equal(headers.get('Pragma'), 'no-cache');
  }
});

test('cookie-authenticated pairing and grant responses vary on Origin and Cookie', async () => {
  for (const url of [
    '/api/v1/pairings/active',
    '/api/v1/pairings/pairing_1',
    '/api/v1/grants?limit=25',
  ]) {
    const headers = new Map<string, string>();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => headers.set(name, value),
        }),
      }),
    } as unknown as ExecutionContext;
    const next = { handle: () => of({ ok: true }) } as CallHandler;
    await new Promise<void>((resolve, reject) => {
      new ResponseHeadersInterceptor(crypto)
        .intercept(context, next)
        .subscribe({ complete: resolve, error: reject });
    });
    assert.equal(headers.get('Vary'), 'Origin, Cookie');
  }
});

test('protected board responses are private and vary across both auth transports', async () => {
  const headers = new Map<string, string>();
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/api/v1/boards/board_1?requestId=request_01' }),
      getResponse: () => ({ setHeader: (name: string, value: string) => headers.set(name, value) }),
    }),
  } as unknown as ExecutionContext;
  const next = {
    handle: () =>
      of({
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: 'request_01',
      }),
  } as CallHandler;
  await new Promise<void>((resolve, reject) => {
    new ResponseHeadersInterceptor(crypto)
      .intercept(context, next)
      .subscribe({ complete: resolve, error: reject });
  });
  assert.equal(headers.get('X-Request-Id'), 'request_01');
  assert.equal(headers.get('Cache-Control'), 'no-store, private');
  assert.equal(headers.get('Pragma'), 'no-cache');
  assert.equal(headers.get('Vary'), 'Origin, Cookie, Authorization');
});

test('account API-key management responses are private and vary only by browser carriers', async () => {
  for (const url of [
    '/api/v1/account/api-keys',
    '/api/v1/account/api-keys?limit=20',
    '/api/v1/account/api-keys/key_public_1',
  ]) {
    const headers = new Map<string, string>();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => headers.set(name, value),
        }),
      }),
    } as unknown as ExecutionContext;
    const next = { handle: () => of({ ok: true }) } as CallHandler;
    await new Promise<void>((resolve, reject) => {
      new ResponseHeadersInterceptor(crypto)
        .intercept(context, next)
        .subscribe({ complete: resolve, error: reject });
    });
    assert.equal(headers.get('Cache-Control'), 'no-store, private');
    assert.equal(headers.get('Pragma'), 'no-cache');
    assert.equal(headers.get('Vary'), 'Origin, Cookie');
  }
});
