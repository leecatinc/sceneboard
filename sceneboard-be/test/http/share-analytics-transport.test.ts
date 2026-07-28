import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateCorsPreflightV1 } from '../../src/common/http/cors-policy.middleware.js';
import { matchRawBodyProfile } from '../../src/common/http/raw-body-profiles.js';

test('registers strict analytics JSON and no-body transport profiles', () => {
  assert.deepEqual(
    matchRawBodyProfile('POST', '/api/v1/public/shares/share-a/view-contexts', 'application/json'),
    {
      kind: 'd2-rest-json-body',
      method: 'POST',
      pathTemplate: '/api/v1/public/shares/:shareId/view-contexts',
    },
  );
  assert.deepEqual(
    matchRawBodyProfile('POST', '/api/v1/public/share-view-events', 'application/json'),
    {
      kind: 'd2-rest-json-body',
      method: 'POST',
      pathTemplate: '/api/v1/public/share-view-events',
    },
  );
  assert.deepEqual(matchRawBodyProfile('GET', '/api/v1/boards/board-a/share-analytics'), {
    kind: 'd1-no-body',
    method: 'GET',
    pathTemplate: '/api/v1/boards/:boardId/share-analytics',
  });
});

test('permits only the exact analytics preflight methods and headers', () => {
  assert.deepEqual(
    evaluateCorsPreflightV1(
      '/api/v1/public/share-view-events',
      'POST',
      'content-type,x-sceneboard-view-csrf',
    ),
    {
      allowed: true,
      method: 'POST',
      headers: ['Content-Type', 'X-SceneBoard-View-CSRF'],
    },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1(
      '/api/v1/public/share-view-events',
      'POST',
      'content-type,x-sceneboard-view-csrf,x-csrf-token',
    ),
    { allowed: false },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1(
      '/api/v1/public/share-view-events',
      'POST',
      'content-type,Content-Type',
    ),
    { allowed: false },
  );
  assert.deepEqual(
    evaluateCorsPreflightV1('/api/v1/boards/board-a/share-analytics', 'POST', undefined),
    { allowed: false },
  );
});
