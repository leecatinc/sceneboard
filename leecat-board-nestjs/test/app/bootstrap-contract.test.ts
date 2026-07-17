import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateCorsPreflightV1 } from '../../src/common/http/cors-policy.middleware.js';

test('CORS route registry confines Last-Event-ID to the exact SSE GET template', () => {
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board_1/events', 'GET', 'last-event-id'),
    { allowed: true, method: 'GET', headers: ['Last-Event-ID'] },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board_1/events', 'GET', undefined),
    { allowed: true, method: 'GET', headers: [] },
  );
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1/events', 'POST', undefined), { allowed: false });
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1', 'GET', 'Last-Event-ID'), { allowed: false });
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1', 'GET', 'Content-Type'), {
    allowed: true, method: 'GET', headers: ['Content-Type'],
  });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/boards/board_1/title',
    'POST',
    'Content-Type, X-CSRF-Token',
  ), { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1/capability-requests/network-fetch',
    'POST',
    'Content-Type, X-CSRF-Token',
  ), { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/boards/board_1/interactions/hitl_1',
    'GET',
    undefined,
  ), { allowed: true, method: 'GET', headers: [] });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/boards/board_1/interactions/hitl_1/supersede',
    'POST',
    'X-CSRF-Token',
  ), { allowed: true, method: 'POST', headers: ['X-CSRF-Token'] });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/boards/board_1/interactions/hitl_1/cancel',
    'GET',
    undefined,
  ), { allowed: false });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/auth/email-verifications',
    'POST',
    'Content-Type',
  ), { allowed: true, method: 'POST', headers: ['Content-Type'] });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/auth/email-verifications/confirm',
    'POST',
    'Content-Type',
  ), { allowed: true, method: 'POST', headers: ['Content-Type'] });
  assert.deepEqual(evaluateCorsPreflightV1(
    '/api/v1/auth/password',
    'POST',
    'Content-Type, X-CSRF-Token',
  ), { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] });
  assert.deepEqual(evaluateCorsPreflightV1('/unknown', 'GET', undefined), { allowed: false });
});
