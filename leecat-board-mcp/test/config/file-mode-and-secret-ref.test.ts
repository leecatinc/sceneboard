import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardConfigError, parseBoardConfigV1 } from '../../src/config/board-config.js';
import { resolveSecretReferenceV1 } from '../../src/config/secret-reference.js';
import { redactSecretsV1 } from '../../src/diagnostics/redact-secrets.js';

const config = {
  version: 1 as const,
  baseUrl: 'https://sceneboard.dev',
  accessTokenRef: 'env://LEECAT_BOARD_ACCESS_TOKEN' as const,
  authScheme: 'bearer' as const,
  timeoutMs: 30_000,
  profile: 'default',
};

test('strict config validates origin, exact keys, timeout, profile, and secret references', () => {
  assert.deepEqual(parseBoardConfigV1(config, 'environment'), config);
  for (const invalid of [
    { ...config, baseUrl: 'http://sceneboard.dev' },
    { ...config, baseUrl: 'https://user:secret@sceneboard.dev' },
    { ...config, baseUrl: 'https://sceneboard.dev/api' },
    { ...config, timeoutMs: 999 },
    { ...config, profile: '../escape' },
    { ...config, accessTokenRef: 'env://OTHER' },
    { ...config, extra: true },
  ]) {
    assert.throws(() => parseBoardConfigV1(invalid, 'environment'), BoardConfigError);
  }
});

test('store resolution is profile-bound and conflicts with environment credentials', () => {
  const stored = parseBoardConfigV1({ ...config, accessTokenRef: 'store://prod', profile: 'prod' }, 'environment');
  assert.deepEqual(resolveSecretReferenceV1(stored, { XDG_STATE_HOME: '/tmp/state' }), {
    kind: 'store',
    profile: 'prod',
    stateDirectory: '/tmp/state/leecat-board/credentials/prod',
  });
  assert.throws(
    () => resolveSecretReferenceV1(stored, { XDG_STATE_HOME: '/tmp/state', LEECAT_BOARD_ACCESS_TOKEN: 'set' }),
    BoardConfigError,
  );
});

test('redaction recursively removes credential, proof, code, and path fields', () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const redacted = redactSecretsV1({ token, nested: { authorization: `Bearer ${token}`, code: 'ABCDEF-GHJKLM' } });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('ABCDEF-GHJKLM'), false);
});
