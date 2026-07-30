import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  corsExposedHeadersV1,
  evaluateCorsPreflightV1,
} from '../../src/common/http/cors-policy.middleware.js';
import { matchRawBodyProfile } from '../../src/common/http/raw-body-profiles.js';

test('CORS route registry confines Last-Event-ID to the exact SSE GET template', () => {
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board_1/events', 'GET', 'last-event-id'),
    { allowed: true, method: 'GET', headers: ['Last-Event-ID'] },
  );
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1/events', 'GET', undefined), {
    allowed: true,
    method: 'GET',
    headers: [],
  });
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1/events', 'POST', undefined), {
    allowed: false,
  });
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1', 'GET', 'Last-Event-ID'), {
    allowed: false,
  });
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1', 'GET', 'Content-Type'), {
    allowed: true,
    method: 'GET',
    headers: ['Content-Type'],
  });
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board_1/title', 'POST', 'Content-Type, X-CSRF-Token'),
    { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board_1/exports', 'POST', 'Content-Type, X-CSRF-Token'),
    { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] },
  );
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/boards/board_1/exports', 'GET', undefined), {
    allowed: false,
  });
  assert.deepEqual(corsExposedHeadersV1('/api/v1/boards/board_1/exports'), [
    'X-Request-Id',
    'X-Auth-Generation',
    'Retry-After',
    'Content-Disposition',
    'Content-Length',
    'X-Content-Type-Options',
  ]);
  assert.deepEqual(corsExposedHeadersV1('/api/v1/boards/board_1'), [
    'X-Request-Id',
    'X-Auth-Generation',
    'Retry-After',
  ]);
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/account/api-keys', 'POST', 'Content-Type, X-CSRF-Token'),
    { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] },
  );
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/account/api-keys', 'GET', undefined), {
    allowed: true,
    method: 'GET',
    headers: [],
  });
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/account/api-keys/key_1', 'DELETE', 'X-CSRF-Token'),
    { allowed: true, method: 'DELETE', headers: ['X-CSRF-Token'] },
  );
  assert.deepEqual(evaluateCorsPreflightV1('/api/v1/account/api-keys/key_1', 'POST', undefined), {
    allowed: false,
  });
  assert.deepEqual(
    matchRawBodyProfile('POST', '/api/v1/boards/board_1/exports', 'application/json'),
    {
      kind: 'd2-rest-json-body',
      method: 'POST',
      pathTemplate: '/api/v1/boards/:boardId/exports',
    },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1(
      '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1/capability-requests/network-fetch',
      'POST',
      'Content-Type, X-CSRF-Token',
    ),
    { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board_1/interactions/hitl_1', 'GET', undefined),
    { allowed: true, method: 'GET', headers: [] },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1(
      '/api/v1/boards/board_1/interactions/hitl_1/supersede',
      'POST',
      'X-CSRF-Token',
    ),
    { allowed: true, method: 'POST', headers: ['X-CSRF-Token'] },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board_1/interactions/hitl_1/cancel', 'GET', undefined),
    { allowed: false },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/auth/email-verifications', 'POST', 'Content-Type'),
    { allowed: true, method: 'POST', headers: ['Content-Type'] },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/auth/email-verifications/confirm', 'POST', 'Content-Type'),
    { allowed: true, method: 'POST', headers: ['Content-Type'] },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/auth/password', 'POST', 'Content-Type, X-CSRF-Token'),
    { allowed: true, method: 'POST', headers: ['Content-Type', 'X-CSRF-Token'] },
  );
  assert.deepEqual(evaluateCorsPreflightV1('/unknown', 'GET', undefined), { allowed: false });
});
