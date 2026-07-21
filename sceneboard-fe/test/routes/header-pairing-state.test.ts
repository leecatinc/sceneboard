import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveHeaderConnectionState } from '../../lib/ai-connections/header-connection-state';

test('header connection state distinguishes pending redemption from an active grant', () => {
  assert.equal(deriveHeaderConnectionState([]), 'idle');
  assert.equal(deriveHeaderConnectionState([{ status: 'expired' }, { status: 'revoked' }]), 'idle');
  assert.equal(deriveHeaderConnectionState([{ status: 'pending_redemption' }]), 'connecting');
  assert.equal(
    deriveHeaderConnectionState([{ status: 'pending_redemption' }, { status: 'active' }]),
    'connected',
  );
});
