import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSecretSafeConfig } from '../../scripts/audit-secret-safe-config.mjs';

test('configuration audit returns metadata only and accepts an ignored untracked local MCP config', async () => {
  const result = await auditSecretSafeConfig();
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.exceptions, [{
    path: '.mcp.json',
    ignored: true,
    tracked: false,
    verifiable: true,
    classification: 'local-only-config',
    reason: 'IGNORED_UNTRACKED_LOCAL_CONFIG',
  }]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /<set-by-secret>|BEGIN PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}/u);
  assert.equal(result.files.find(({ path }) => path === '.mcp.json')?.modeClass, 'owner-only');
  assert.ok(result.keyPaths.some(({ keyPath, classification }) => keyPath === 'MYSQL_PASSWORD' && classification === 'secret-reference'));
});
