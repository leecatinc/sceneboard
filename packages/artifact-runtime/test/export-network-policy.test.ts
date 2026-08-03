import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createExportNetworkPolicyV1, inspectExportReadinessV1 } from '../src/export/index.js';

const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA';

test('export network policy admits only the fixed loopback document, broker, and runtime assets', () => {
  const policy = createExportNetworkPolicyV1({
    webOrigin: 'http://127.0.0.1:3410',
    apiOrigin: 'http://127.0.0.1:3411',
    runtimeOrigin: 'http://127.0.0.1:3420',
    sessionId,
  });
  assert.equal(
    policy.allows(`http://127.0.0.1:3410/internal/export-render/${sessionId}`, 'document'),
    true,
  );
  assert.equal(
    policy.allows(
      `http://127.0.0.1:3411/internal/v1/export-render/${sessionId}/projection`,
      'fetch',
    ),
    true,
  );
  assert.equal(
    policy.isBrokerRequest(
      `http://127.0.0.1:3411/internal/v1/export-render/${sessionId}/projection`,
      'fetch',
    ),
    true,
  );
  for (const resourceType of ['fetch', 'xhr', 'image', 'font']) {
    assert.equal(
      policy.isBrokerRequest(
        `http://127.0.0.1:3411/internal/v1/export-render/${sessionId}/resources/${'a'.repeat(64)}`,
        resourceType,
      ),
      true,
    );
  }
  assert.equal(policy.isBrokerRequest(policy.documentUrl, 'document'), false);
  assert.equal(
    policy.allows(
      `http://127.0.0.1:3411/internal/v1/export-render/${sessionId}/resources/${'a'.repeat(64)}`,
      'font',
    ),
    true,
  );
  assert.equal(policy.allows('http://127.0.0.1:3420/runner', 'document'), true);
  assert.equal(
    policy.allows(`http://127.0.0.1:3420/assets/outer.${'b'.repeat(64)}.js`, 'script'),
    true,
  );
  for (const denied of [
    'https://example.com/',
    `http://127.0.0.1:3411/internal/v1/export-render/${sessionId}/projection?q=1`,
    'file:///etc/passwd',
    'ws://127.0.0.1:3410/socket',
    'http://127.0.0.1:3420/healthz',
  ])
    assert.equal(policy.allows(denied, 'fetch'), false, denied);
  assert.throws(() =>
    createExportNetworkPolicyV1({
      webOrigin: 'https://sceneboard.dev',
      apiOrigin: 'http://127.0.0.1:3411',
      runtimeOrigin: 'http://127.0.0.1:3420',
      sessionId,
    }),
  );
  assert.throws(() =>
    createExportNetworkPolicyV1({
      webOrigin: 'http://127.999.0.1:3410',
      apiOrigin: 'http://127.0.0.1:3411',
      runtimeOrigin: 'http://127.0.0.1:3420',
      sessionId,
    }),
  );
});

test('export readiness fails unsupported and pending resources closed', () => {
  const root = (
    unsupported: boolean,
    images: Array<{ complete: boolean; naturalWidth: number }>,
    artifacts: Array<{ classList: { contains(value: string): boolean } }>,
  ) =>
    ({
      querySelector: () => (unsupported ? {} : null),
      querySelectorAll: (selector: string) => (selector === 'img' ? images : artifacts),
    }) as unknown as ParentNode;
  assert.deepEqual(inspectExportReadinessV1(root(true, [], [])), {
    ready: false,
    reason: 'unsupported',
  });
  assert.deepEqual(
    inspectExportReadinessV1(root(false, [{ complete: false, naturalWidth: 0 }], [])),
    { ready: false, reason: 'pending' },
  );
  assert.deepEqual(
    inspectExportReadinessV1(
      root(false, [{ complete: true, naturalWidth: 1 }], [{ classList: { contains: () => true } }]),
    ),
    { ready: true },
  );
});
