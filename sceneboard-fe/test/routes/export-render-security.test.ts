import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildExportRenderDocumentPolicyV1,
  isLoopbackHostV1,
  matchesExportWebHostV1,
} from '../../middleware';

test('internal export renderer has a dedicated loopback-only document policy', () => {
  const policy = buildExportRenderDocumentPolicyV1(
    'AAAAAAAAAAAAAAAAAAAAAAAA',
    'http://127.0.0.1:3411',
    'http://127.0.0.1:3420',
  );
  assert.match(policy, /default-src 'none'/u);
  assert.match(policy, /connect-src http:\/\/127\.0\.0\.1:3411/u);
  assert.match(policy, /frame-src http:\/\/127\.0\.0\.1:3420/u);
  assert.match(policy, /frame-ancestors 'none'/u);
  assert.match(policy, /worker-src 'none'/u);
  assert.doesNotMatch(policy, /https:|wss:|unsafe-eval/u);
  assert.throws(() =>
    buildExportRenderDocumentPolicyV1(
      'AAAAAAAAAAAAAAAAAAAAAAAA',
      'https://api.example.com',
      'http://127.0.0.1:3420',
    ),
  );
  assert.throws(() =>
    buildExportRenderDocumentPolicyV1(
      'AAAAAAAAAAAAAAAAAAAAAAAA',
      'http://127.999.0.1:3411',
      'http://127.0.0.1:3420',
    ),
  );
});

test('internal export renderer compares the configured loopback host without Next URL rewriting', () => {
  assert.equal(matchesExportWebHostV1('127.0.0.1:3410', 'http://127.0.0.1:3410'), true);
  assert.equal(matchesExportWebHostV1('localhost:3410', 'http://127.0.0.1:3410'), false);
  assert.equal(matchesExportWebHostV1('127.0.0.1:3411', 'http://127.0.0.1:3410'), false);
  assert.equal(matchesExportWebHostV1(null, 'http://127.0.0.1:3410'), false);
  assert.throws(() => matchesExportWebHostV1('api.example.com', 'https://api.example.com'));
});

test('internal export renderer accepts Node IPv4-mapped loopback peers only', () => {
  assert.equal(isLoopbackHostV1('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackHostV1('::FFFF:127.255.255.255'), true);
  assert.equal(isLoopbackHostV1('::ffff:126.255.255.255'), false);
  assert.equal(isLoopbackHostV1('::ffff:192.168.0.1'), false);
  assert.equal(isLoopbackHostV1('::ffff:127.0.0.999'), false);
});

test('internal export route remains outside public route inventories and requires its bearer', () => {
  const middleware = readFileSync(new URL('../../middleware.ts', import.meta.url), 'utf8');
  const route = readFileSync(
    new URL('../../app/internal/export-render/[sessionId]/ExportRenderClient.tsx', import.meta.url),
    'utf8',
  );
  assert.match(middleware, /\/internal\/export-render\/:path\*/u);
  assert.match(middleware, /SceneBoard-Export/u);
  assert.match(middleware, /x-forwarded-for/u);
  assert.match(route, /inspectExportReadinessV1/u);
  assert.match(route, /document\.fonts\.ready/u);
  assert.match(route, /redirect: 'error'/u);
  assert.doesNotMatch(route, /localStorage|sessionStorage|document\.cookie/u);
});
