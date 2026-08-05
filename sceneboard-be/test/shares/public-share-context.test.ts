import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { CryptoService } from '../../src/common/security/crypto.service.js';
import type { AppEnvironment } from '../../src/config/env.schema.js';
import { PublicContextCookieService } from '../../src/shares/public-context-cookie.service.js';

const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const crypto = {
  randomBase64Url: () => token,
} as unknown as CryptoService;

const environment = (input: {
  browserOrigin: string;
  nodeEnv: 'development' | 'production';
}): AppEnvironment =>
  ({
    browserOrigin: input.browserOrigin,
    nodeEnv: input.nodeEnv,
  }) as AppEnvironment;

test('production context cookie is isolated, host-only, HttpOnly, and absolute', () => {
  const service = new PublicContextCookieService(
    environment({ browserOrigin: 'https://sceneboard.dev', nodeEnv: 'production' }),
    crypto,
  );
  const issued = service.issue('sceneboard.dev');
  assert.equal(
    issued.setCookie,
    `__Host-sceneboard_public_context=${token}; Max-Age=1800; Path=/; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.equal(issued.digest.byteLength, 32);
  assert.equal(
    service.inspect(`unrelated=1; __Host-sceneboard_public_context=${token}`, 'sceneboard.dev')
      .kind,
    'valid',
  );
});

test('context cookie inspection distinguishes absent, malformed, and duplicate authority', () => {
  const service = new PublicContextCookieService(
    environment({ browserOrigin: 'http://localhost:3410', nodeEnv: 'development' }),
    crypto,
  );
  assert.equal(service.inspect(undefined, 'localhost').kind, 'absent');
  assert.equal(service.inspect('sceneboard_public_context_dev=bad', 'localhost').kind, 'invalid');
  assert.equal(
    service.inspect(
      `sceneboard_public_context_dev=${token}; sceneboard_public_context_dev=${token}`,
      'localhost',
    ).kind,
    'invalid',
  );
  assert.equal(
    service.issue('localhost').setCookie,
    `sceneboard_public_context_dev=${token}; Max-Age=1800; Path=/; HttpOnly; SameSite=Lax`,
  );
});

test('context renewal accepts Redis Lua status replies and compares stored ISO expiries directly', () => {
  const store = readFileSync(
    new URL('../../src/shares/public-context.store.ts', import.meta.url),
    'utf8',
  );
  const resolver = readFileSync(
    new URL('../../src/shares/public-share.resolver.ts', import.meta.url),
    'utf8',
  );
  assert.match(store, /if not redis\.call\('SET',[\s\S]*?'NX'\) then return -1 end/u);
  assert.doesNotMatch(store, /redis\.call\('SET',[\s\S]*?~= 'OK'/u);
  assert.match(resolver, /new Date\(input\.context\.validUntil\)\.valueOf\(\)/u);
  assert.match(resolver, /new Date\(input\.context\.familyExpiresAt\)\.valueOf\(\)/u);
  assert.doesNotMatch(
    resolver,
    /parseMysqlTimestampUtc\(input\.context\.(?:validUntil|familyExpiresAt)\)/u,
  );
});

test('public share resolution acquires board and share locks in one canonical order', () => {
  const resolver = readFileSync(
    new URL('../../src/shares/public-share.resolver.ts', import.meta.url),
    'utf8',
  );
  const byShareId = resolver.match(
    /async withPublicShareId[\s\S]*?const observed = await this\.shares\.readShareById[\s\S]*?const board = await this\.lockBoard[\s\S]*?const share = await this\.shares\.lockShareById/u,
  );
  assert.notEqual(byShareId, null);
});
