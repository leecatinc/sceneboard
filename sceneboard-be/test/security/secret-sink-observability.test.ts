import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKEND_SECRET_SINKS_V1,
  dispatchBackendSecretSinkV1,
  type BackendSecretSinkV1,
} from '../../src/common/security/secret-sink-observability.js';

const canary = `sk-${'A'.repeat(43)}`;

test('every backend observability sink receives only production-redacted records', () => {
  for (const sink of BACKEND_SECRET_SINKS_V1) {
    const observed: string[] = [];
    const result = dispatchBackendSecretSinkV1({
      sink,
      rawPayload: { payload: canary, nested: { diagnostic: canary } },
      observer: { observe: (bytes) => observed.push(bytes) },
    });
    assert.equal(result.disposition, 'SANITIZED');
    assert.equal(result.observedRecords, observed.length);
    assert.ok(observed.length > 0);
    assert.equal(
      observed.some((bytes) => bytes.includes(canary)),
      false,
    );
  }
});

test('unknown backend sinks and unavailable observers fail closed', () => {
  assert.throws(
    () =>
      dispatchBackendSecretSinkV1({
        sink: 'UNKNOWN' as BackendSecretSinkV1,
        rawPayload: { payload: canary },
        observer: { observe: () => {} },
      }),
    /unsupported backend secret sink/u,
  );
  assert.throws(
    () =>
      dispatchBackendSecretSinkV1({
        sink: 'APPLICATION_LOG',
        rawPayload: { payload: canary },
        observer: null as never,
      }),
    /observer is required/u,
  );
});

test('observer failure aborts the backend dispatch', () => {
  assert.throws(
    () =>
      dispatchBackendSecretSinkV1({
        sink: 'ERROR',
        rawPayload: { payload: canary },
        observer: {
          observe: () => {
            throw new Error('capture unavailable');
          },
        },
      }),
    /capture unavailable/u,
  );
});
