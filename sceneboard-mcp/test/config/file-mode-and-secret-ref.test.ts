import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BOARD_CONFIG_MAX_BYTES_V1,
  BoardConfigError,
  parseBoardConfigV1,
  readBoardConfigFileV1,
} from '../../src/config/board-config.js';
import { discoverBoardConfigV1 } from '../../src/config/config-discovery.js';
import { resolveSecretReferenceV1 } from '../../src/config/secret-reference.js';
import { redactSecretsV1 } from '../../src/diagnostics/redact-secrets.js';

const config = {
  version: 1 as const,
  baseUrl: 'https://sceneboard.dev',
  accessTokenRef: 'env://SCENEBOARD_ACCESS_TOKEN' as const,
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
  const stored = parseBoardConfigV1(
    { ...config, accessTokenRef: 'store://prod', profile: 'prod' },
    'environment',
  );
  assert.deepEqual(resolveSecretReferenceV1(stored, { XDG_STATE_HOME: '/tmp/state' }), {
    kind: 'store',
    profile: 'prod',
    stateDirectory: '/tmp/state/leecat-board/credentials/prod',
  });
  assert.throws(
    () =>
      resolveSecretReferenceV1(stored, {
        XDG_STATE_HOME: '/tmp/state',
        SCENEBOARD_ACCESS_TOKEN: 'set',
      }),
    BoardConfigError,
  );
});

test('explicit API-key mode accepts only its environment reference or matching private store', () => {
  const apiKey = parseBoardConfigV1(
    {
      ...config,
      accessTokenRef: 'env://SCENEBOARD_API_KEY',
      credentialMode: 'api_key',
    },
    'environment',
  );
  assert.equal(apiKey.credentialMode, 'api_key');
  assert.deepEqual(resolveSecretReferenceV1(apiKey, {}), {
    kind: 'environment',
    variable: 'SCENEBOARD_API_KEY',
  });
  const stored = parseBoardConfigV1(
    {
      ...config,
      accessTokenRef: 'store://owner',
      profile: 'owner',
      credentialMode: 'api_key',
    },
    'environment',
  );
  assert.deepEqual(resolveSecretReferenceV1(stored, { XDG_STATE_HOME: '/tmp/state' }), {
    kind: 'store',
    profile: 'owner',
    stateDirectory: '/tmp/state/leecat-board/credentials/owner',
  });
  for (const invalid of [
    {
      ...config,
      accessTokenRef: 'env://SCENEBOARD_ACCESS_TOKEN',
      credentialMode: 'api_key',
    },
    {
      ...config,
      accessTokenRef: 'env://SCENEBOARD_API_KEY',
      credentialMode: 'pairing',
    },
    { ...config, credentialMode: 'unknown' },
  ])
    assert.throws(() => parseBoardConfigV1(invalid, 'environment'), BoardConfigError);
});

test('selected config files use one no-follow handle and reject unsafe size or metadata changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'board-config-held-handle-'));
  const selected = join(root, 'selected.json');
  const replacement = join(root, 'replacement.json');
  const link = join(root, 'linked.json');
  const oversized = join(root, 'oversized.json');
  const originalBytes = JSON.stringify(config);
  const replacementConfig = { ...config, baseUrl: 'https://replacement.sceneboard.dev' };
  try {
    await writeFile(selected, originalBytes, { mode: 0o600 });
    await writeFile(replacement, JSON.stringify(replacementConfig), { mode: 0o600 });
    const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
    const approvedStatus = await handle.stat({ bigint: true });
    await rename(replacement, selected);
    try {
      await assert.rejects(
        readBoardConfigFileV1(handle, 'process_option', approvedStatus),
        BoardConfigError,
      );
    } finally {
      await handle.close();
    }

    await symlink(selected, link);
    await assert.rejects(
      discoverBoardConfigV1({
        argv: [`--config=${link}`],
        cwd: root,
        env: {},
        ...(process.geteuid === undefined ? {} : { effectiveUserId: process.geteuid() }),
      }),
      BoardConfigError,
    );

    await writeFile(oversized, originalBytes, { mode: 0o600 });
    await truncate(oversized, BOARD_CONFIG_MAX_BYTES_V1 + 1);
    await chmod(oversized, 0o600);
    await assert.rejects(
      discoverBoardConfigV1({
        argv: [`--config=${oversized}`],
        cwd: root,
        env: {},
        ...(process.geteuid === undefined ? {} : { effectiveUserId: process.geteuid() }),
      }),
      BoardConfigError,
    );

    const mutable = await open(selected, constants.O_RDWR | constants.O_NOFOLLOW);
    const statusBeforeMutation = await mutable.stat({ bigint: true });
    await mutable.truncate(0);
    await mutable.writeFile(originalBytes);
    await assert.rejects(
      readBoardConfigFileV1(mutable, 'process_option', statusBeforeMutation),
      BoardConfigError,
    );
    await mutable.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('redaction recursively removes credential, proof, code, and path fields', () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const redacted = redactSecretsV1({
    token,
    nested: { authorization: `Bearer ${token}`, code: 'ABCDEF-GHJKLM' },
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('ABCDEF-GHJKLM'), false);
});
