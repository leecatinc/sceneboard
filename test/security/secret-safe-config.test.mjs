import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSecretSafeConfig } from '../../scripts/audit-secret-safe-config.mjs';

test('configuration audit returns metadata only and accepts an absent or ignored untracked local MCP config', async () => {
  const result = await auditSecretSafeConfig();
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.findings, []);
  assert.equal(result.exceptions.length, 1);
  assert.equal(result.exceptions[0]?.path, '.mcp.json');
  assert.equal(result.exceptions[0]?.classification, 'local-only-config');
  assert.match(
    result.exceptions[0]?.reason ?? '',
    /^(?:ABSENT_LOCAL_CONFIG|IGNORED_UNTRACKED_LOCAL_CONFIG)$/u,
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /<set-by-secret>|BEGIN PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}/u);
  assert.match(
    result.files.find(({ path }) => path === '.mcp.json')?.modeClass ?? '',
    /^(?:absent|owner-only)$/u,
  );
  assert.ok(
    result.keyPaths.some(
      ({ keyPath, classification }) =>
        keyPath === 'MYSQL_PASSWORD' && classification === 'secret-reference',
    ),
  );
});
