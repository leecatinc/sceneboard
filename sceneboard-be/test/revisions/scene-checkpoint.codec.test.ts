import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import { SceneCheckpointCodec } from '../../src/revisions/scene-checkpoint.codec.js';

const isCheckpointIntegrityError = (error: unknown): boolean =>
  error instanceof BoardPersistenceError && error.category === 'checkpoint_integrity';

test('round-trips a canonical empty scene through bounded Brotli checkpoint v1', async () => {
  const codec = new SceneCheckpointCodec();
  const checkpoint = await codec.encode({ protocolVersion: 1, type: 'scene', root: null });
  assert.equal(checkpoint.schemaVersion, '1.0.0');
  assert.equal(checkpoint.codec, 'B');
  assert.ok(checkpoint.canonicalBytes >= 1 && checkpoint.canonicalBytes <= 786_432);
  assert.equal(checkpoint.storedBytes, checkpoint.payload.byteLength);
  assert.equal(checkpoint.sha256.byteLength, 32);
  const decoded = await codec.decode(checkpoint);
  assert.deepEqual(decoded.scene, { protocolVersion: 1, type: 'scene', root: null });
  assert.deepEqual(decoded.canonicalBytes, checkpoint.canonicalPayload);
});

test('fails closed on corrupt payload, digest, length, or storage bounds', async () => {
  const codec = new SceneCheckpointCodec();
  const checkpoint = await codec.encode({ protocolVersion: 1, type: 'scene', root: null });
  await assert.rejects(
    () => codec.decode({ ...checkpoint, payload: Buffer.from('not-brotli') }),
    isCheckpointIntegrityError,
  );
  await assert.rejects(
    () => codec.decode({ ...checkpoint, sha256: Buffer.alloc(32) }),
    isCheckpointIntegrityError,
  );
  await assert.rejects(
    () => codec.decode({ ...checkpoint, canonicalBytes: checkpoint.canonicalBytes + 1 }),
    isCheckpointIntegrityError,
  );
  await assert.rejects(
    () => codec.decode({ ...checkpoint, storedBytes: 800_001 }),
    isCheckpointIntegrityError,
  );
});
