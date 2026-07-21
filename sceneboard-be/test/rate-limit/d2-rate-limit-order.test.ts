import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { AppEnvironment } from '../../src/config/env.schema.js';
import {
  D2PostAuthRateLimitGuard,
  D2PreAuthRateLimitGuard,
} from '../../src/rate-limit/d2-rate-limit.guards.js';
import type { RateLimitService } from '../../src/rate-limit/rate-limit.service.js';

const reflector = { getAllAndOverride: () => 'pairing-create' } as unknown as Reflector;
const environment = { trustedProxyCidrs: [] } as unknown as AppEnvironment;
const surfaceReflector = (surface: string) =>
  ({ getAllAndOverride: () => surface }) as unknown as Reflector;
const context = (request: object) =>
  ({
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

test('pairing create limiter consumes parsed IP before DB-resolved owner identity', async () => {
  const calls: string[] = [];
  const limiter = {
    async consume(input: { surface: string; identity: string }) {
      calls.push(`${input.surface}:${input.identity}`);
    },
  } as RateLimitService;
  const request = {
    body: {},
    headers: {},
    socket: { remoteAddress: '192.0.2.19' },
    authSession: { user: { publicId: 'user_1' } },
  };
  await new D2PreAuthRateLimitGuard(reflector, limiter, environment).canActivate(context(request));
  await new D2PostAuthRateLimitGuard(reflector, limiter).canActivate(context(request));
  assert.deepEqual(calls, ['pairing-create:192.0.2.0/24', 'pairing-create-owner:user_1']);
});

test('proof routes consume IP first and a proof-fingerprinted pairing bucket second', async () => {
  const inputs: Array<{
    surface: string;
    purpose: string;
    identity: string;
    limit: number;
    windowMs: number;
  }> = [];
  const limiter = {
    async consume(input: {
      surface: string;
      purpose: string;
      identity: string;
      limit: number;
      windowMs: number;
    }) {
      inputs.push(input);
    },
  } as RateLimitService;
  const proofReflector = {
    getAllAndOverride: () => 'pairing-client-status',
  } as unknown as Reflector;
  const request = {
    headers: {},
    params: { pairingId: 'pairing_1' },
    socket: { remoteAddress: '192.0.2.19' },
    pairingProof: { rateLimitFingerprint: 'proof_fingerprint' },
  };
  await new D2PreAuthRateLimitGuard(proofReflector, limiter, environment).canActivate(
    context(request),
  );
  await new D2PostAuthRateLimitGuard(proofReflector, limiter).canActivate(context(request));
  assert.deepEqual(inputs, [
    {
      surface: 'pairing-client-status',
      purpose: 'rate-limit-ip/v1',
      identity: '192.0.2.0/24',
      limit: 300,
      windowMs: 300_000,
    },
    {
      surface: 'pairing-client-status-proof',
      purpose: 'rate-limit-pairing/v1',
      identity: 'pairing_1\u0000proof_fingerprint',
      limit: 120,
      windowMs: 300_000,
    },
  ]);
});

test('signup consumes the masked IP bucket before the normalized email bucket', async () => {
  const inputs: Array<{
    surface: string;
    purpose: string;
    identity: string;
    limit: number;
    windowMs: number;
  }> = [];
  const limiter = {
    async consume(input: {
      surface: string;
      purpose: string;
      identity: string;
      limit: number;
      windowMs: number;
    }) {
      inputs.push(input);
    },
  } as RateLimitService;
  const request = {
    body: {
      email: ' User@Example.dev ',
      password: 'valid-password',
      verificationTicket: `v1.${'x'.repeat(100)}`,
    },
    headers: {},
    socket: { remoteAddress: '2001:db8:1234:5678::10' },
  };
  await new D2PreAuthRateLimitGuard(surfaceReflector('signup'), limiter, environment).canActivate(
    context(request),
  );
  assert.deepEqual(inputs, [
    {
      surface: 'signup',
      purpose: 'rate-limit-ip/v1',
      identity: '2001:db8:1234:5600::/56',
      limit: 5,
      windowMs: 3_600_000,
    },
    {
      surface: 'signup-email',
      purpose: 'rate-limit-email/v1',
      identity: 'user@example.dev',
      limit: 3,
      windowMs: 3_600_000,
    },
  ]);
});

test('email verification send consumes the hourly IP bucket before the normalized email bucket', async () => {
  const inputs: Array<{
    surface: string;
    purpose: string;
    identity: string;
    limit: number;
    windowMs: number;
  }> = [];
  const limiter = {
    async consume(input: {
      surface: string;
      purpose: string;
      identity: string;
      limit: number;
      windowMs: number;
    }) {
      inputs.push(input);
    },
  } as RateLimitService;
  const request = {
    body: { email: ' User@Example.dev ', locale: 'ko' },
    headers: {},
    socket: { remoteAddress: '203.0.113.10' },
  };
  await new D2PreAuthRateLimitGuard(
    surfaceReflector('email-verification-request'),
    limiter,
    environment,
  ).canActivate(context(request));
  assert.deepEqual(inputs, [
    {
      surface: 'email-verification-request',
      purpose: 'rate-limit-ip/v1',
      identity: '203.0.113.0/24',
      limit: 10,
      windowMs: 3_600_000,
    },
    {
      surface: 'email-verification-request-email',
      purpose: 'rate-limit-email/v1',
      identity: 'user@example.dev',
      limit: 3,
      windowMs: 3_600_000,
    },
  ]);
});

test('password change consumes the IP bucket before the authenticated owner bucket', async () => {
  const inputs: Array<{
    surface: string;
    purpose: string;
    identity: string;
    limit: number;
    windowMs: number;
  }> = [];
  const limiter = {
    async consume(input: {
      surface: string;
      purpose: string;
      identity: string;
      limit: number;
      windowMs: number;
    }) {
      inputs.push(input);
    },
  } as RateLimitService;
  const request = {
    body: { currentPassword: 'current-password', newPassword: 'replacement-password' },
    headers: {},
    socket: { remoteAddress: '192.0.2.19' },
    authSession: { user: { publicId: 'user_1' } },
  };
  const passwordReflector = surfaceReflector('password-change');
  await new D2PreAuthRateLimitGuard(passwordReflector, limiter, environment).canActivate(
    context(request),
  );
  await new D2PostAuthRateLimitGuard(passwordReflector, limiter).canActivate(context(request));
  assert.deepEqual(inputs, [
    {
      surface: 'password-change',
      purpose: 'rate-limit-ip/v1',
      identity: '192.0.2.0/24',
      limit: 20,
      windowMs: 900_000,
    },
    {
      surface: 'password-change-owner',
      purpose: 'rate-limit-user/v1',
      identity: 'user_1',
      limit: 5,
      windowMs: 3_600_000,
    },
  ]);
});

test('CSRF bootstrap uses the fixed Redis-unavailable retry contract', async () => {
  const inputs: Array<{
    surface: string;
    purpose: string;
    identity: string;
    limit: number;
    windowMs: number;
    unavailableRetryAfterSeconds?: number;
  }> = [];
  const limiter = {
    async consume(input: (typeof inputs)[number]) {
      inputs.push(input);
    },
  } as RateLimitService;
  const request = { headers: {}, socket: { remoteAddress: '192.0.2.19' } };
  await new D2PreAuthRateLimitGuard(
    surfaceReflector('csrf-bootstrap'),
    limiter,
    environment,
  ).canActivate(context(request));
  assert.deepEqual(inputs, [
    {
      surface: 'csrf-bootstrap',
      purpose: 'rate-limit-ip/v1',
      identity: '192.0.2.0/24',
      limit: 60,
      windowMs: 600_000,
      unavailableRetryAfterSeconds: 5,
    },
  ]);
});

test('grant rotation consumes the IP bucket before the owner-and-grant bucket', async () => {
  const inputs: Array<{
    surface: string;
    purpose: string;
    identity: string;
    limit: number;
    windowMs: number;
  }> = [];
  const limiter = {
    async consume(input: {
      surface: string;
      purpose: string;
      identity: string;
      limit: number;
      windowMs: number;
    }) {
      inputs.push(input);
    },
  } as RateLimitService;
  const request = {
    body: {},
    headers: {},
    params: { grantId: 'grant_1' },
    socket: { remoteAddress: '192.0.2.19' },
    authSession: { user: { publicId: 'user_1' } },
  };
  const grantReflector = surfaceReflector('grant-rotate');
  await new D2PreAuthRateLimitGuard(grantReflector, limiter, environment).canActivate(
    context(request),
  );
  await new D2PostAuthRateLimitGuard(grantReflector, limiter).canActivate(context(request));
  assert.deepEqual(inputs, [
    {
      surface: 'grant-rotate',
      purpose: 'rate-limit-ip/v1',
      identity: '192.0.2.0/24',
      limit: 60,
      windowMs: 3_600_000,
    },
    {
      surface: 'grant-rotate-owner',
      purpose: 'rate-limit-grant/v1',
      identity: 'user_1\u0000grant_1',
      limit: 5,
      windowMs: 3_600_000,
    },
  ]);
});
