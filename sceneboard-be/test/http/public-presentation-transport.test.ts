import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { evaluateCorsPreflightV1 } from '../../src/common/http/cors-policy.middleware.js';
import { matchRawBodyProfile } from '../../src/common/http/raw-body-profiles.js';

const contextId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sessionId = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const base = `/api/v1/public/share-contexts/${contextId}/presentation-sessions`;

test('live presentation routes use exact no-body and bounded JSON profiles', () => {
  assert.deepEqual(matchRawBodyProfile('GET', base), {
    kind: 'd2-no-body',
    method: 'GET',
    pathTemplate: '/api/v1/public/share-contexts/:contextId/presentation-sessions',
  });
  assert.deepEqual(matchRawBodyProfile('POST', base, 'application/json'), {
    kind: 'd2-rest-json-body',
    method: 'POST',
    pathTemplate: '/api/v1/public/share-contexts/:contextId/presentation-sessions',
  });
  assert.deepEqual(matchRawBodyProfile('GET', `${base}/${sessionId}/events`), {
    kind: 'd2-no-body',
    method: 'GET',
    pathTemplate:
      '/api/v1/public/share-contexts/:contextId/presentation-sessions/:sessionId/events',
  });
  assert.deepEqual(matchRawBodyProfile('POST', `${base}/${sessionId}/state`, 'application/json'), {
    kind: 'd2-rest-json-body',
    method: 'POST',
    pathTemplate: '/api/v1/public/share-contexts/:contextId/presentation-sessions/:sessionId/state',
  });
});

test('owner live presentation routes use the authenticated board transport profiles', () => {
  const ownerBase = '/api/v1/boards/board_1234567890123456789012/presentation-sessions';
  assert.deepEqual(matchRawBodyProfile('GET', ownerBase), {
    kind: 'd2-no-body',
    method: 'GET',
    pathTemplate: '/api/v1/boards/:boardId/presentation-sessions',
  });
  assert.deepEqual(matchRawBodyProfile('POST', ownerBase, 'application/json'), {
    kind: 'd2-rest-json-body',
    method: 'POST',
    pathTemplate: '/api/v1/boards/:boardId/presentation-sessions',
  });
  assert.deepEqual(matchRawBodyProfile('GET', `${ownerBase}/${sessionId}/events`), {
    kind: 'd2-no-body',
    method: 'GET',
    pathTemplate: '/api/v1/boards/:boardId/presentation-sessions/:sessionId/events',
  });
});

test('live presentation CORS admits only the declared browser mutations', () => {
  assert.deepEqual(evaluateCorsPreflightV1(base, 'POST', 'content-type'), {
    allowed: true,
    method: 'POST',
    headers: ['Content-Type'],
  });
  assert.deepEqual(evaluateCorsPreflightV1(`${base}/${sessionId}/state`, 'POST', 'content-type'), {
    allowed: true,
    method: 'POST',
    headers: ['Content-Type'],
  });
  assert.deepEqual(evaluateCorsPreflightV1(`${base}/${sessionId}/events`, 'POST', undefined), {
    allowed: false,
  });
});

test('live presentation SSE uses one authorization lease per bounded connection', () => {
  const controller = readFileSync(
    new URL('../../src/shares/public-presentation-session.controller.ts', import.meta.url),
    'utf8',
  );
  const ownerController = readFileSync(
    new URL('../../src/shares/owner-presentation-session.controller.ts', import.meta.url),
    'utf8',
  );
  const service = readFileSync(
    new URL('../../src/shares/public-presentation-session.service.ts', import.meta.url),
    'utf8',
  );
  assert.equal(controller.match(/sessions\.authorize\(contextId, cookieHeader\)/gu)?.length, 1);
  assert.match(controller, /while \(!stopped[\s\S]*?getAuthorized\(authorized, sessionId\)/u);
  assert.doesNotMatch(controller, /while \(!stopped[\s\S]*?sessions\.get\(\{/u);
  assert.equal(ownerController.match(/ownerSessions\.authorize\(/gu)?.length, 1);
  assert.match(
    ownerController,
    /while \(!stopped[\s\S]*?sessions\.getAuthorized\(authorized, sessionId\)/u,
  );
  assert.doesNotMatch(ownerController, /while \(!stopped[\s\S]*?ownerSessions\.authorize\(/u);
  assert.match(controller, /Date\.now\(\) - startedAt < 25_000/u);
  assert.match(ownerController, /Date\.now\(\) - startedAt < 25_000/u);
  assert.match(controller, /D2RateLimited\('public-presentation-update'\)/u);
  assert.match(service, /timingSafeEqual/u);
  assert.match(service, /surface: 'public-presentation-update-family'/u);
  assert.match(service, /purpose: 'rate-limit-session\/v1'/u);
  assert.match(service, /actorDigest\.toString\('hex'\)[^\n]*\\u0000\$\{sessionId\}/u);
  assert.match(service, /if \(!isPresenter\([\s\S]*?PublicShareHttpError\(404\)/u);
  assert.match(service, /tonumber\(current\.version\)[\s\S]*?return 'CONFLICT'/u);
  assert.match(service, /ZCARD[\s\S]*?return 'CAP'/u);
});
