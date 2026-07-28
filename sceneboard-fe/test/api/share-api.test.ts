import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShareManagementViewV1 } from '@sceneboard/board-schema';

import { ShareApi } from '../../lib/api/share-api';
import type { SessionRequestCoordinator } from '../../lib/auth/renewal-singleflight';

const share = {
  shareId: 'share_1',
  status: 'active' as const,
  accessPolicy: 'L' as const,
  pinnedRevisionId: 'revision_1',
  publicationGeneration: 1,
  accessGeneration: 1,
  version: 1,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
} as unknown as ShareManagementViewV1;

test('share client preserves CSRF/idempotency identity and strictly parses initial secret', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const coordinator = {
    currentSnapshot: () => ({ csrfToken: 'csrf-token' }),
    dispatchShared: async (request: Record<string, unknown>) => {
      requests.push(request);
      return {
        kind: 'ok',
        value: {
          response: new Response(null, { status: 200 }),
          body: { status: 'rotated', share, linkToken: 'A'.repeat(43) },
        },
      };
    },
  } as unknown as SessionRequestCoordinator;
  const result = await new ShareApi(coordinator).rotate('board_1', share, 'share-operation:0001');
  assert.equal(result.kind, 'ok');
  assert.deepEqual(requests[0], {
    path: '/api/v1/boards/board_1/shares/share_1/rotate-link',
    method: 'POST',
    body: { expectedVersion: 1 },
    csrfToken: 'csrf-token',
    idempotencyKey: 'share-operation:0001',
  });
});

test('share client rejects success bodies with both plaintext fields', async () => {
  const coordinator = {
    currentSnapshot: () => ({ csrfToken: 'csrf-token' }),
    dispatchShared: async () => ({
      kind: 'ok',
      value: {
        response: new Response(null, { status: 200 }),
        body: {
          status: 'rotated',
          share,
          linkToken: 'A'.repeat(43),
          password: 'B'.repeat(24),
        },
      },
    }),
  } as unknown as SessionRequestCoordinator;
  const result = await new ShareApi(coordinator).rotate('board_1', share, 'share-operation:0002');
  assert.deepEqual(result, { kind: 'corrupt_response' });
});
