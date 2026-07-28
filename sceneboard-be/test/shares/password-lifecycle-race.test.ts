import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('rechecks the full credential tuple after scrypt and binds grants to access generation', async () => {
  const service = await readFile(
    new URL('../../src/shares/password-share.service.ts', import.meta.url),
    'utf8',
  );
  const repository = await readFile(
    new URL('../../src/shares/password-share.repository.ts', import.meta.url),
    'utf8',
  );
  const shares = await readFile(
    new URL('../../src/shares/share.repository.ts', import.meta.url),
    'utf8',
  );
  assert.match(service, /tupleEqual\(share\.credential, observed\.credential!\)/u);
  assert.match(service, /lockShareByTokenDigest/u);
  assert.match(repository, /access_generation, credential_version/u);
  assert.match(repository, /LEAST\(\?, \? \+ INTERVAL 30 MINUTE\)/u);
  assert.match(shares, /DELETE FROM share_password_session_grants WHERE share_pk = \?/u);
});

test('rotate, revoke and archive invalidate password grants under the share lock', async () => {
  const source = await readFile(
    new URL('../../src/shares/share.repository.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    (source.match(/invalidatePasswordAccess\(connection, share\.sharePk/gu) ?? []).length >= 3,
  );
  assert.match(source, /LEFT JOIN share_password_credentials/u);
  assert.match(source, /credentialPresent: true/u);
});
