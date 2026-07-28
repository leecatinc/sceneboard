import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditEventCatalog, prepareAuditMetadata } from '../../src/audit/audit-events.js';

test('owns a stable unique numeric audit catalog and event-specific metadata allowlists', () => {
  const codes = Object.values(AuditEventCatalog);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(
    codes.every((code) => Number.isInteger(code) && code > 0 && code <= 65_535),
    true,
  );
  assert.deepEqual(prepareAuditMetadata('login_success', { workFactorUpgraded: true }), {
    workFactorUpgraded: true,
  });
  assert.deepEqual(prepareAuditMetadata('password_change', { otherSessionFamiliesRevoked: 2 }), {
    otherSessionFamiliesRevoked: 2,
  });
  assert.deepEqual(
    prepareAuditMetadata('hitl.request.created', {
      boardPk: 1n,
      actorKind: 'mcp_client',
      interactionKind: 'form',
      nextState: 'open',
      eventSequence: 4,
      replayed: false,
    }),
    {
      boardPk: '1',
      actorKind: 'mcp_client',
      interactionKind: 'form',
      nextState: 'open',
      eventSequence: 4,
      replayed: false,
    },
  );
  assert.throws(() =>
    prepareAuditMetadata('hitl.response.answered', { response: 'must-not-persist' }),
  );
  assert.deepEqual(
    prepareAuditMetadata('artifact.network.denied', {
      boardPk: '1',
      versionPk: '2',
      actorKind: 'user',
      operation: 'network',
      status: 'denied',
      capability: 'network.fetch',
      outcome: 'policy_denied',
    }),
    {
      boardPk: '1',
      versionPk: '2',
      actorKind: 'user',
      operation: 'network',
      status: 'denied',
      capability: 'network.fetch',
      outcome: 'policy_denied',
    },
  );
  assert.throws(() =>
    prepareAuditMetadata('artifact.package.read', { packageBytes: 'must-not-persist' }),
  );
  assert.throws(() =>
    prepareAuditMetadata('artifact.network.denied', { url: 'https://secret.example' }),
  );
  assert.throws(() =>
    prepareAuditMetadata('artifact.publication.created', { source: '<script>secret</script>' }),
  );
  assert.deepEqual(
    prepareAuditMetadata('media.ingested', {
      boardPk: '1',
      actorKind: 'mcp_client',
      mime: 'image/png',
      bytes: 128,
      replayed: false,
      outcome: 'created',
    }),
    {
      boardPk: '1',
      actorKind: 'mcp_client',
      mime: 'image/png',
      bytes: 128,
      replayed: false,
      outcome: 'created',
    },
  );
  assert.throws(() => prepareAuditMetadata('media.ingested', { mediaId: 'media_secret' }));
  assert.throws(() => prepareAuditMetadata('login_success', { email: 'must-not-persist' }));
});

test('redacts secret-shaped values before audit metadata serialization', () => {
  assert.deepEqual(
    prepareAuditMetadata('session_reuse', { reason: 'rotated', detail: { TOKEN: 'canary' } }),
    { reason: 'rotated', detail: { TOKEN: '[REDACTED]' } },
  );
});
