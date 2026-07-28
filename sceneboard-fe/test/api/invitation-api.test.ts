import assert from 'node:assert/strict';
import test from 'node:test';

import { InvitationApi } from '../../lib/api/invitation-api';
import type { SessionRequestCoordinator } from '../../lib/auth/renewal-singleflight';

test('invitation client strictly admits the owner access list', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const coordinator = {
    currentSnapshot: () => ({ csrfToken: 'csrf-token' }),
    dispatchShared: async (request: Record<string, unknown>) => {
      requests.push(request);
      return {
        kind: 'ok',
        value: {
          response: new Response(null, { status: 200 }),
          body: {
            members: [{ memberId: 'member_1', accountId: 'account_1', role: 'viewer', version: 1 }],
            invitations: [
              {
                inviteId: 'invite_1',
                role: 'editor',
                expiresAt: '2026-08-04T00:00:00.000Z',
                state: 'pending',
              },
            ],
          },
        },
      };
    },
  } as unknown as SessionRequestCoordinator;
  const result = await new InvitationApi(coordinator).list('board_1');
  assert.equal(result.kind, 'ok');
  assert.deepEqual(requests, [{ path: '/api/v1/boards/board_1/members', method: 'GET' }]);
});
