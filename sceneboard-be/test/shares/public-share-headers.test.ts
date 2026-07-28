import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPublicArtifactHeaders,
  applyPublicProjectionHeaders,
  publicFailureBody,
} from '../../src/shares/share-response-policy.js';

class HeaderCapture {
  readonly values = new Map<string, string>();

  setHeader(name: string, value: string): void {
    this.values.set(name, value);
  }
}

test('projection policy emits the exact private API header family', () => {
  const response = new HeaderCapture();
  applyPublicProjectionHeaders(response, 405);
  assert.deepEqual(Object.fromEntries(response.values), {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex,nofollow,noarchive',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private,no-store',
    Pragma: 'no-cache',
    'Content-Security-Policy':
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    Vary: 'Cookie, Origin',
    Allow: 'GET',
  });
});

test('artifact policy separates success and authorized range failure', () => {
  const success = new HeaderCapture();
  applyPublicArtifactHeaders(success, 200);
  assert.equal(success.values.get('Content-Type'), 'application/vnd.leecat.artifact-package.v1');
  assert.equal(
    success.values.get('Content-Disposition'),
    'attachment; filename="sceneboard-artifact.pkg"',
  );
  assert.equal(success.values.get('Pragma'), undefined);
  const range = new HeaderCapture();
  applyPublicArtifactHeaders(range, 416, 1234);
  assert.equal(range.values.get('Content-Range'), 'bytes */1234');
  assert.equal(range.values.get('Content-Type'), 'application/json; charset=utf-8');
});

test('public failure bodies are metadata-minimized and rate bounds are clamped', () => {
  assert.deepEqual(publicFailureBody(404, null), { state: 'unavailable' });
  assert.deepEqual(publicFailureBody(503, 1), { state: 'unavailable' });
  assert.deepEqual(publicFailureBody(429, 901), {
    state: 'rate-limited',
    retryAfterSeconds: 900,
  });
});
