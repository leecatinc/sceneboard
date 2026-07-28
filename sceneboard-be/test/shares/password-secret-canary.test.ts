import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('keeps plaintext passwords and family tokens outside durable and diagnostic sinks', async () => {
  const files = await Promise.all(
    [
      '../../src/database/migrations/sql/020_d9_share_password_auth.up.sql',
      '../../src/shares/password-share.repository.ts',
      '../../src/shares/password-attempt.service.ts',
      '../../src/audit/audit-events.ts',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  );
  const durable = files.join('\n');
  assert.doesNotMatch(durable, /raw_password|plaintext_password|password_value|family_token/u);
  assert.match(durable, /password_hash BINARY\(32\)/u);
  assert.match(durable, /family_digest BINARY\(32\)/u);
  assert.doesNotMatch(durable, /console\.(?:log|error|warn)|logger\./u);
});
