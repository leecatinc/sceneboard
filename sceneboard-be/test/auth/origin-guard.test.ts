import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertAllowedOrigin,
  assertAllowedOriginOrSameOriginFetch,
} from '../../src/common/guards/origin.guard.js';
import { AppError } from '../../src/common/errors/app-error.js';

test('origin-only routes accept exactly the configured browser origin', () => {
  assert.doesNotThrow(() => assertAllowedOrigin('http://127.0.0.1:3410', 'http://127.0.0.1:3410'));
  for (const origin of [undefined, 'http://localhost:3410', 'http://127.0.0.1:3410/']) {
    assert.throws(
      () => assertAllowedOrigin(origin, 'http://127.0.0.1:3410'),
      (error) => error instanceof AppError && error.code === 'CSRF_INVALID',
    );
  }
});

test('origin-only routes accept an origin-less same-origin browser fetch and reject weaker metadata', () => {
  const allowedOrigin = 'https://sceneboard.leecat.co.kr';
  assert.doesNotThrow(() =>
    assertAllowedOriginOrSameOriginFetch({
      origin: undefined,
      fetchSite: 'same-origin',
      fetchMode: 'cors',
      allowedOrigin,
    }),
  );
  assert.doesNotThrow(() =>
    assertAllowedOriginOrSameOriginFetch({
      origin: allowedOrigin,
      fetchSite: 'cross-site',
      fetchMode: 'cors',
      allowedOrigin,
    }),
  );
  for (const input of [
    { origin: undefined, fetchSite: undefined, fetchMode: undefined },
    { origin: undefined, fetchSite: 'same-site', fetchMode: 'cors' },
    { origin: undefined, fetchSite: 'same-origin', fetchMode: 'navigate' },
    { origin: 'https://attacker.example', fetchSite: 'same-origin', fetchMode: 'cors' },
  ]) {
    assert.throws(
      () => assertAllowedOriginOrSameOriginFetch({ ...input, allowedOrigin }),
      (error) => error instanceof AppError && error.code === 'CSRF_INVALID',
    );
  }
});
