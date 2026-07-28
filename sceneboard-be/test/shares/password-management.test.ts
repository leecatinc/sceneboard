import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('binds owner password transitions to exact authorization, replay, recovery and invalidation', async () => {
  const source = await readFile(
    new URL('../../src/shares/password-share.service.ts', import.meta.url),
    'utf8',
  );
  for (const operation of [
    'share.password.enable',
    'share.password.regenerate',
    'share.password.disable',
  ]) {
    assert.match(source, new RegExp(`'${operation.replaceAll('.', '\\.')}'`, 'u'));
  }
  assert.match(source, /ShareFingerprintInputParserV1/u);
  assert.match(source, /findReplay/u);
  assert.match(source, /persistIdempotency/u);
  assert.match(source, /recovery\.plan/u);
  assert.match(source, /appendInvalidation/u);
  assert.match(source, /copySecretAvailable: false/u);
  assert.match(source, /regenerateRequired: true/u);
});

test('owns the one anonymous admission route without account-session authorization', async () => {
  const source = await readFile(
    new URL('../../src/shares/password-share.controller.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /@Post\(':shareToken\/password-sessions'\)/u);
  assert.match(source, /x-sceneboard-share-csrf/u);
  assert.match(source, /maximumForwardedEntries: 32/u);
  assert.doesNotMatch(source, /RequireBoardPrincipal|RequireCsrf\('session'\)/u);
});
