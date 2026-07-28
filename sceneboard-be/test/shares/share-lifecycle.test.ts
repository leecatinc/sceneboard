import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { shareStateDigest } from '../../src/shares/share.repository.js';

test('implements the closed publication/access generation transition matrix', async () => {
  const repository = await readFile(
    new URL('../../src/shares/share.repository.ts', import.meta.url),
    'utf8',
  );
  assert.match(repository, /publication_generation = \?, access_generation = \?/u);
  assert.match(repository, /pinned_revision_pk = \?, publication_generation = \?/u);
  assert.match(repository, /token_digest = \?, access_generation = \?/u);
  assert.match(repository, /status = 'revoked'.*access_generation = \?/su);
  assert.match(repository, /status = 'archived'.*access_generation = \?/su);
  assert.match(repository, /value >= MAX_GENERATION/u);
});

test('acquires the new publication hold before releasing the old one', async () => {
  const service = await readFile(
    new URL('../../src/shares/share-publication.service.ts', import.meta.url),
    'utf8',
  );
  const update = service.slice(
    service.indexOf("} else if (plan.operation === 'update')"),
    service.indexOf("} else if (plan.operation === 'rotate')"),
  );
  assert.ok(update.indexOf('await this.acquirePublication') >= 0);
  assert.ok(
    update.indexOf('await this.releasePublication') >
      update.indexOf('await this.acquirePublication'),
  );
  assert.match(service, /secretReplay\(plan\.operation, updated\.shareId\)/u);
  assert.match(service, /copySecretAvailable: false/u);
  assert.match(service, /appendInvalidation/u);
  assert.match(service, /updateResult\?\.status !== 'unchanged'/u);
});

test('archives shares inside the existing board archive transaction', async () => {
  const archive = await readFile(
    new URL('../../src/boards/board-archive.service.ts', import.meta.url),
    'utf8',
  );
  assert.ok(archive.indexOf('archiveWithinBoardTransaction') < archive.indexOf('UPDATE boards'));
});

test('binds every stale-access discriminator into the recovery state digest', () => {
  const baseline = {
    shareId: 'share_1',
    boardPk: 1n,
    status: 'active' as const,
    accessPolicy: 'L' as const,
    pinnedRevisionPk: 2n,
    publicationGeneration: 3,
    accessGeneration: 4,
    tokenDigest: Buffer.alloc(32, 5),
    version: 6,
  };
  const digest = shareStateDigest(baseline);
  for (const changed of [
    { ...baseline, pinnedRevisionPk: 3n },
    { ...baseline, publicationGeneration: 4 },
    { ...baseline, accessGeneration: 5 },
    { ...baseline, tokenDigest: Buffer.alloc(32, 6) },
    { ...baseline, version: 7 },
    { ...baseline, status: 'revoked' as const },
  ]) {
    assert.equal(digest.equals(shareStateDigest(changed)), false);
  }
});
