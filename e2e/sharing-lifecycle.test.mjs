import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('public and password shares remain pinned, noindex, viewer-only, and lifecycle fenced', () => {
  const route = read('sceneboard-fe/app/s/[shareToken]/page.tsx');
  const publication = read('sceneboard-be/src/shares/share-publication.service.ts');
  const projection = read('sceneboard-be/src/shares/public-share-projection.repository.ts');
  const password = read('sceneboard-be/src/shares/password-hash.service.ts');
  assert.match(route, /robots: \{ index: false, follow: false, nocache: true \}/u);
  assert.match(publication, /pinnedRevisionId/u);
  assert.match(publication, /operation === 'rotate'/u);
  assert.match(publication, /operation === 'revoke'/u);
  assert.match(publication, /accessGeneration/u);
  assert.match(projection, /pinnedRevisionPk/u);
  assert.match(projection, /publicationGeneration/u);
  assert.match(password, /scrypt/u);
});

test('owner share controls expose explicit update, rotate, revoke, and password actions only', () => {
  const sheet = read('sceneboard-fe/components/board/ShareManagementSheet.tsx');
  for (const key of [
    'sharing.updateRevision',
    'sharing.rotateLink',
    'sharing.revoke',
    'sharing.enablePassword',
    'sharing.regeneratePassword',
    'sharing.disablePassword',
  ])
    assert.match(sheet, new RegExp(key.replace('.', '\\.'), 'u'));
  for (const deferred of ['organization', 'domain', 'gallery', 'comment', 'clone'])
    assert.doesNotMatch(sheet, new RegExp(`shareType.*${deferred}`, 'iu'));
});
