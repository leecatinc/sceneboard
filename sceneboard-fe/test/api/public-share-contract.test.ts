import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { decodePublicShareClientState } from '../../lib/api/public-share-contract.js';

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
  assert.match(source, /duplicate upstream cookie/u);
  assert.doesNotMatch(clientSource, /shareToken/u);
});
