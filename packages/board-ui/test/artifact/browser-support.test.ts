import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  artifactIsolationModeV1,
  buildOpaqueArtifactRunnerDocumentV1,
} from '../../src/artifact/browser-support.js';

test('server environments fail closed when no browser isolation primitive exists', () => {
  assert.equal(artifactIsolationModeV1(), 'unsupported');
});

test('opaque runner document pins the runtime, nonce, CORS, and restrictive policy', () => {
  const document = buildOpaqueArtifactRunnerDocumentV1(
    'https://artifact.sceneboard.dev',
    'AAAAAAAAAAAAAAAAAAAAAAAA',
  );
  assert.match(document, /base href="https:\/\/artifact\.sceneboard\.dev\/"/u);
  assert.match(document, /script-src https:\/\/artifact\.sceneboard\.dev 'nonce-/u);
  assert.match(
    document,
    /src="https:\/\/artifact\.sceneboard\.dev\/runner\.js" crossorigin="anonymous" nonce=/u,
  );
  assert.match(document, /connect-src 'none'/u);
  assert.match(document, /frame-src about: blob:/u);
  assert.match(document, /referrer" content="no-referrer/u);
  assert.doesNotMatch(document, /allow-same-origin|allow-forms|allow-popups/u);
});

test('opaque runner document rejects non-canonical origins and unsafe nonces', () => {
  assert.throws(
    () => buildOpaqueArtifactRunnerDocumentV1('https://artifact.sceneboard.dev/path', null),
    /origin is invalid/u,
  );
  assert.throws(
    () => buildOpaqueArtifactRunnerDocumentV1('https://artifact.sceneboard.dev', '"bad'),
    /nonce is invalid/u,
  );
});
