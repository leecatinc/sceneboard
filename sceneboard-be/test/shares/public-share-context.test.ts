import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { CryptoService } from '../../src/common/security/crypto.service.js';
import type { AppEnvironment } from '../../src/config/env.schema.js';
import { PublicContextCookieService } from '../../src/shares/public-context-cookie.service.js';
import { PublicContextStore } from '../../src/shares/public-context.store.js';

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
  assert.match(store, /if contextExpiry > familyExpiry then return 2 end/u);
  assert.match(store, /if not redis\.call\('SET',[\s\S]*?'NX'\) then return -1 end/u);
  assert.doesNotMatch(store, /redis\.call\('SET',[\s\S]*?~= 'OK'/u);
  assert.match(resolver, /new Date\(input\.context\.validUntil\)\.valueOf\(\)/u);
  assert.match(resolver, /new Date\(input\.context\.familyExpiresAt\)\.valueOf\(\)/u);
  assert.doesNotMatch(
    resolver,
    /parseMysqlTimestampUtc\(input\.context\.(?:validUntil|familyExpiresAt)\)/u,
  );
});

test('context renewal rotates the cookie family before a fresh context crosses its expiry', async () => {
  const now = new Date('2026-08-12T00:00:00.000Z');
  const oldDigest = Buffer.alloc(32, 1);
  const nextDigest = Buffer.alloc(32, 2);
  const evaluations: string[] = [];
  const store = new PublicContextStore(
    {
      evaluate: async (script: string) => {
        if (script.includes("local family = redis.call('GET', KEYS[1])")) {
          evaluations.push('reuse-needs-rotation');
          return 2;
        }
        if (script.includes("redis.call('MSET', KEYS[1]")) {
          evaluations.push('create-family');
          return 1;
        }
        throw new Error('unexpected Redis script');
      },
    } as never,
    {
      issue: () => ({
        token,
        digest: nextDigest,
        setCookie: `__Host-sceneboard_public_context=${token}; Max-Age=1800; Path=/; Secure; HttpOnly; SameSite=Lax`,
      }),
    } as never,
    { redis: { keyPrefix: 'sceneboard:' } } as AppEnvironment,
  );

  const result = await store.persist({
    contextId: 'B'.repeat(43),
    cookie: { kind: 'valid', token: 'old', digest: oldDigest },
    hostname: 'sceneboard.dev',
    now,
    validUntil: new Date(now.valueOf() + 60_000),
    tuple: {
      sharePk: 1n,
      boardPk: 2n,
      revisionPk: 3n,
      publicationGeneration: 4,
      accessGeneration: 5,
    },
  });

  assert.deepEqual(evaluations, ['reuse-needs-rotation', 'create-family']);
  assert.deepEqual(result.familyDigest, nextDigest);
  assert.match(result.setCookie ?? '', /^__Host-sceneboard_public_context=/u);
  assert.equal(result.familyExpiresAt.toISOString(), '2026-08-12T00:30:00.000Z');
});

test('revalidation forwards a rotated context cookie instead of converting it to 503', () => {
  const projection = readFileSync(
    new URL('../../src/shares/public-share-projection.service.ts', import.meta.url),
    'utf8',
  );
  const controller = readFileSync(
    new URL('../../src/shares/public-share.controller.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(projection, /persisted\.setCookie !== null[^;]+503/u);
  assert.match(controller, /result\.setCookies\.length > 0[\s\S]*?Set-Cookie/u);
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
