import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import {
  CHECKPOINT_LIMITS,
  DocumentCheckpointCodec,
} from '../../src/revisions/document-checkpoint.codec.js';

const emptyScene = { protocolVersion: 1 as const, type: 'scene' as const, root: null };
const emptyDocument = {
  schemaVersion: 2 as const,
  defaultPageId: 'page_1',
  pages: [
    {
      pageId: 'page_1',
      title: '',
      displayMode: 'fit-page' as const,
      scene: emptyScene,
    },
  ],
};
const emptyDocumentV3 = {
  ...emptyDocument,
  schemaVersion: 3 as const,
  format: 'wide_16_9' as const,
};

const isCheckpointIntegrityError = (error: unknown): boolean =>
  error instanceof BoardPersistenceError && error.category === 'checkpoint_integrity';

test('round-trips exact v1 scene, v2 document and v3 document checkpoint branches', async () => {
  const codec = new DocumentCheckpointCodec();
  const scene = await codec.encodeScene(emptyScene);
  const document = await codec.encodeDocument(emptyDocument);
  const documentV3 = await codec.encodeDocumentV3(emptyDocumentV3);

  assert.equal(scene.schemaVersion, '1.0.0');
  assert.equal(document.schemaVersion, '2.0.0');
  assert.equal(documentV3.schemaVersion, '3.0.0');
  assert.equal(scene.codec, 'B');
  assert.equal(document.codec, 'B');
  assert.deepEqual(await codec.decode(scene), {
    kind: 'scene',
    scene: emptyScene,
    canonicalBytes: scene.canonicalPayload,
  });
  assert.deepEqual(await codec.decode(document), {
    kind: 'document',
    document: emptyDocument,
    canonicalBytes: document.canonicalPayload,
  });
  assert.deepEqual(await codec.decode(documentV3), {
    kind: 'document',
    document: emptyDocumentV3,
    canonicalBytes: documentV3.canonicalPayload,
  });
});

test('enforces the discriminator-specific canonical and stored limits before decoding', async () => {
  const codec = new DocumentCheckpointCodec();
  const scene = await codec.encodeScene(emptyScene);
  const document = await codec.encodeDocument(emptyDocument);

  assert.deepEqual(CHECKPOINT_LIMITS, {
    '1.0.0': { canonicalBytes: 786_432, storedBytes: 800_000 },
    '2.0.0': { canonicalBytes: 20_971_520, storedBytes: 33_554_432 },
    '3.0.0': { canonicalBytes: 20_971_520, storedBytes: 33_554_432 },
  });
  await assert.rejects(
    () =>
      codec.decode({
        ...scene,
        schemaVersion: '2.0.0',
        canonicalBytes: scene.canonicalBytes + 1,
      }),
    isCheckpointIntegrityError,
  );
  await assert.rejects(
    () =>
      codec.decode({
        ...document,
        schemaVersion: '1.0.0',
        storedBytes: CHECKPOINT_LIMITS['1.0.0'].storedBytes + 1,
      }),
    isCheckpointIntegrityError,
  );
  await assert.rejects(
    () => codec.decode({ ...document, schemaVersion: '2.0.0', codec: 'b' }),
    isCheckpointIntegrityError,
  );
  await assert.rejects(
    () => codec.decode({ ...document, schemaVersion: '2.0.0', sha256: Buffer.alloc(32) }),
    isCheckpointIntegrityError,
  );
});
