import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('keeps plaintext link tokens out of persistence, audit, outbox, and logging sinks', async () => {
  const migration = await readFile(
    new URL('../../src/database/migrations/sql/019_d9_board_shares.up.sql', import.meta.url),
    'utf8',
  );
  const repository = await readFile(
    new URL('../../src/shares/share.repository.ts', import.meta.url),
    'utf8',
  );
  const publication = await readFile(
    new URL('../../src/shares/share-publication.service.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(migration, /link_token|plaintext_token/iu);
  assert.doesNotMatch(repository, /console\.|logger\.|linkToken|\.token\b/u);
  assert.doesNotMatch(publication, /console\.|logger\./u);
  assert.match(repository, /token_digest/u);
  assert.match(publication, /linkToken: planned\.plan\.token/u);
  assert.match(publication, /result: replay/u);
});
