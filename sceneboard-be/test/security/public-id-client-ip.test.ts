import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseClientId,
  parsePairingId,
  parseSessionId,
  parseUserId,
} from '../../src/common/ids/public-id.js';
import { maskClientIpPrefix, resolveClientIp } from '../../src/common/security/client-ip.js';

test('delegates every D2 public ID to the frozen D1 global-ID wire set', () => {
  for (const parse of [parseUserId, parseSessionId, parsePairingId, parseClientId]) {
    assert.equal(parse('_valid-01'), '_valid-01');
    assert.throws(() => parse('invalid.id'));
    assert.throws(() => parse('x'.repeat(129)));
  }
});

test('ignores spoofed forwarding headers from untrusted peers', () => {
  const result = resolveClientIp({
    socketAddress: '203.0.113.9',
    xForwardedFor: '198.51.100.1',
    trustedProxyCidrs: ['10.0.0.0/8'],
  });
  assert.deepEqual(result, { address: '203.0.113.9', forwardingState: 'ignored_untrusted_peer' });
});

test('walks a trusted forwarding chain right-to-left and fails safely on malformed input', () => {
  const resolved = resolveClientIp({
    socketAddress: '10.0.0.5',
    xForwardedFor: '198.51.100.25, 10.0.0.4',
    trustedProxyCidrs: ['10.0.0.0/8'],
  });
  assert.deepEqual(resolved, { address: '198.51.100.25', forwardingState: 'trusted_chain' });

  const malformed = resolveClientIp({
    socketAddress: '10.0.0.5',
    xForwardedFor: '198.51.100.25, not-an-ip',
    trustedProxyCidrs: ['10.0.0.0/8'],
  });
  assert.deepEqual(malformed, { address: '10.0.0.5', forwardingState: 'malformed_fallback' });
});

test('canonicalizes mapped IPv4 and masks IPv4/IPv6 limiter prefixes', () => {
  assert.equal(maskClientIpPrefix('::ffff:192.0.2.129'), '192.0.2.0/24');
  assert.equal(maskClientIpPrefix('192.0.3.1'), '192.0.3.0/24');
  assert.equal(maskClientIpPrefix('2001:db8:abcd:12ff::1'), '2001:db8:abcd:1200::/56');
});
