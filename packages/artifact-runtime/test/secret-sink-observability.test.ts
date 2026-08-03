import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_SECRET_SINKS_V1,
  rejectArtifactSecretSinkV1,
  type ArtifactSecretSinkV1,
} from '../src/policy/secret-sink-observability.js';

test('artifact secret sinks reject before reading raw payload or creating browser artifacts', () => {
  const unreadableRawPayload = new Proxy(
    {},
    {
      get: () => {
        throw new Error('raw payload was read');
      },
      ownKeys: () => {
        throw new Error('raw payload was enumerated');
      },
    },
  );
  for (const sink of ARTIFACT_SECRET_SINKS_V1) {
    const observed: string[] = [];
    const result = rejectArtifactSecretSinkV1({
      sink,
      rawPayload: unreadableRawPayload,
      observer: { observe: (bytes) => observed.push(bytes) },
    });
    assert.equal(result.disposition, 'REJECTED_UNSUPPORTED');
    assert.equal(result.observedRecords, 1);
    assert.deepEqual(observed, [JSON.stringify({ code: 'SECRET_SINK_REJECTED', sink })]);
  }
});

test('unknown artifact sinks and observer failures fail closed', () => {
  assert.throws(
    () =>
      rejectArtifactSecretSinkV1({
        sink: 'UNKNOWN' as ArtifactSecretSinkV1,
        rawPayload: null,
        observer: { observe: () => {} },
      }),
    /unsupported artifact secret sink/u,
  );
  assert.throws(
    () =>
      rejectArtifactSecretSinkV1({
        sink: 'DOM',
        rawPayload: null,
        observer: {
          observe: () => {
            throw new Error('capture unavailable');
          },
        },
      }),
    /capture unavailable/u,
  );
});
