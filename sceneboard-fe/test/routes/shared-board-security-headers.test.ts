import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildPublicShareDocumentPolicyV1 } from '../../middleware';

test('public share document policy is nonce-bound and excludes broad application authorities', () => {
  const policy = buildPublicShareDocumentPolicyV1(
    'AAAAAAAAAAAAAAAAAAAAAAAA',
    'http://127.0.0.1:3411',
    'http://127.0.0.2:3412',
  );
  assert.match(policy, /script-src 'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAAAA' 'strict-dynamic'/u);
  assert.match(policy, /style-src 'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAAAA'/u);
  assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:3411/u);
  assert.match(policy, /frame-src http:\/\/127\.0\.0\.2:3412 about: blob:/u);
  assert.match(policy, /frame-ancestors 'none'/u);
  assert.doesNotMatch(policy, /frame-src[^;]*'self'|frame-src[^;]*\*/u);
  assert.doesNotMatch(policy, /unsafe-inline|\*/u);
});

test('middleware owns the complete private document header set and broad CSP excludes /s', () => {
  const middleware = readFileSync(new URL('../../middleware.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');
  for (const header of [
    'Content-Security-Policy',
    'Cache-Control',
    'Pragma',
    'Referrer-Policy',
    'X-Content-Type-Options',
    'X-Robots-Tag',
  ])
    assert.match(middleware, new RegExp(header, 'u'));
  assert.match(middleware, /private,no-store/u);
  assert.match(middleware, /noindex,nofollow,noarchive/u);
  assert.match(config, /\(\?!s\(\?:\/\|\$\)\)/u);
});
