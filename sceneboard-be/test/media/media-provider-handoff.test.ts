import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import { MysqlMediaOwnershipProvider } from '../../src/media/media-ownership.provider.js';
import { MediaWriterGate } from '../../src/media/media-writer-gate.js';

const digests = {
  migration: 'migration',
  projection: 'projection',
  nativeManifest: 'native',
};

test('one exact current-boot certificate enables upload and media mutation together', () => {
  const gate = new MediaWriterGate('2026-07-28T00:00:00.000Z', digests);
  assert.equal(gate.isReady(), false);
  assert.equal(
    gate.enable({
      revisionMediaRefsReady: true,
      mediaStoreProjectionReady: true,
      mediaRetentionRecoveryReady: true,
      mediaNativeDecoderReady: true,
      artifactDigests: digests,
      checkedAt: '2026-07-28T00:00:01.000Z',
    }),
    true,
  );
  assert.doesNotThrow(() => gate.assertUploadReady());
  assert.doesNotThrow(() => gate.assertMutationReady());
  gate.disable();
  assert.throws(() => gate.assertUploadReady(), BoardContractError);
  assert.throws(() => gate.assertMutationReady(), BoardContractError);
});

test('stale or partial evidence performs no absent-table ownership query', async () => {
  const gate = new MediaWriterGate('2026-07-28T00:00:00.000Z', digests);
  gate.enable({
    revisionMediaRefsReady: true,
    mediaStoreProjectionReady: true,
    mediaRetentionRecoveryReady: true,
    mediaNativeDecoderReady: false,
    artifactDigests: digests,
    checkedAt: '2026-07-28T00:00:01.000Z',
  });
  let queries = 0;
  const provider = new MysqlMediaOwnershipProvider(gate);
  await assert.rejects(
    provider.assertOwnedByBoard(
      {
        query: async () => {
          queries += 1;
          return [[]];
        },
      } as never,
      1n,
      ['media_1'] as never,
    ),
    BoardContractError,
  );
  assert.equal(queries, 0);
});
