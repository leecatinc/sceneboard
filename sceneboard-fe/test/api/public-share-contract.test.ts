import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  decodePublicShareBootstrapResponse,
  decodePublicShareClientState,
  decodePublicShareRevalidationResponse,
} from '../../lib/api/public-share-contract.js';

test('client decoder accepts only token-free strict public states', () => {
  assert.deepEqual(decodePublicShareClientState({ state: 'unavailable' }), {
    state: 'unavailable',
  });
  assert.throws(() =>
    decodePublicShareClientState({
      state: 'unavailable',
      shareToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }),
  );
});

test('bootstrap and token-free revalidation use separate closed state unions', () => {
  assert.deepEqual(
    decodePublicShareBootstrapResponse({
      state: 'password-required',
      csrfToken: 'v1.token',
    }),
    { state: 'password-required', csrfToken: 'v1.token' },
  );
  assert.throws(() =>
    decodePublicShareRevalidationResponse({
      state: 'password-required',
      csrfToken: 'v1.token',
    }),
  );
  assert.throws(() =>
    decodePublicShareBootstrapResponse({ state: 'unavailable', expiresAt: null }),
  );
});

test('server-only transport owns the token and state-dependent cookie allowlist', async () => {
  const source = await readFile(
    new URL('../../lib/api/public-share-server.ts', import.meta.url),
    'utf8',
  );
  const clientSource = await readFile(
    new URL('../../lib/api/public-share-contract.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /import 'server-only'/u);
  assert.match(source, /PublicShareTokenParserV1/u);
  assert.match(source, /__Host-sceneboard_public_context/u);
  assert.match(source, /__Host-sceneboard_share/u);
  assert.match(source, /maximumAge: 0/u);
  assert.match(source, /maximumAge: 1_800/u);
  assert.match(source, /result\.kind === 'accepted'/u);
  assert.match(source, /result\.kind === 'invalid' && result\.reason === 'csrf'/u);
  assert.match(source, /values\.length !== 0/u);
  assert.match(source, /response\.status === 404 && error\.code === 'BOARD_NOT_FOUND'/u);
  assert.match(source, /response\.status === 503/u);
  assert.match(source, /response\.headers\.get\('retry-after'\) === '1'/u);
  assert.match(source, /duplicate upstream cookie/u);
  assert.doesNotMatch(clientSource, /shareToken/u);
});
