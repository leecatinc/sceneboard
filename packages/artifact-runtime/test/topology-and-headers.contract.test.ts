import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ARTIFACT_ORIGIN_EVIDENCE_SCHEMA_V2,
  assertArtifactRuntimeTopologyV1,
} from '../src/topology/index.js';
import {
  buildRunnerHeadersV1,
  routeArtifactRuntimeRequestV1,
  type ArtifactRuntimeAssetsV1,
} from '../src/server/index.js';

const HASH = 'a'.repeat(64);
const evidence = (now = new Date('2026-07-16T00:00:00.000Z')) => ({
  schemaVersion: ARTIFACT_ORIGIN_EVIDENCE_SCHEMA_V2,
  generatedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 15 * 60 * 1_000).toISOString(),
  frontendOrigin: 'http://127.0.0.1:3410',
  apiOrigin: 'http://127.0.0.1:3411',
  runtimeOrigin: 'http://127.0.0.2:3412',
  appEnv: 'test' as const,
  frontendInputSha256: HASH,
  backendInputSha256: HASH,
  runtimeInputSha256: HASH,
});

const topology = () => assertArtifactRuntimeTopologyV1({
  appEnv: 'test',
  frontendOrigin: 'http://127.0.0.1:3410',
  apiOrigin: 'http://127.0.0.1:3411',
  runtimeOrigin: 'http://127.0.0.2:3412',
  listenHost: '127.0.0.2',
  listenPort: 3412,
  evidence: evidence(),
  expectedInputSha256: { frontend: HASH, backend: HASH, runtime: HASH },
  now: new Date('2026-07-16T00:01:00.000Z'),
});

test('topology accepts only fresh exact local evidence on a dedicated runtime cookie host', () => {
  assert.equal(topology().expectedHost, '127.0.0.2:3412');
  assert.throws(() => assertArtifactRuntimeTopologyV1({
    appEnv: 'test',
    frontendOrigin: 'http://127.0.0.1:3410',
    apiOrigin: 'http://127.0.0.1:3411',
    runtimeOrigin: 'http://127.0.0.1:3412',
    listenHost: '127.0.0.1',
    listenPort: 3412,
    evidence: evidence(),
    expectedInputSha256: { frontend: HASH, backend: HASH, runtime: HASH },
  }), /cookie hostname/u);
  assert.throws(() => assertArtifactRuntimeTopologyV1({
    appEnv: 'test',
    frontendOrigin: 'http://127.0.0.1:3410',
    apiOrigin: 'http://127.0.0.1:3411',
    runtimeOrigin: 'http://127.0.0.1:3410',
    listenHost: '127.0.0.1',
    listenPort: 3410,
    evidence: evidence(),
    expectedInputSha256: { frontend: HASH, backend: HASH, runtime: HASH },
  }), /distinct/u);
  assert.throws(() => assertArtifactRuntimeTopologyV1({
    appEnv: 'test',
    frontendOrigin: 'http://127.0.0.1:3410',
    apiOrigin: 'http://127.0.0.1:3411',
    runtimeOrigin: 'http://127.0.0.2:3412',
    listenHost: '127.0.0.2',
    listenPort: 3412,
    evidence: evidence(),
    expectedInputSha256: { frontend: HASH, backend: HASH, runtime: HASH },
    now: new Date('2026-07-16T00:16:00.000Z'),
  }), /stale/u);
});

test('runner headers are exact and omit credential/CORS fields', () => {
  const headers = buildRunnerHeadersV1({
    appOrigin: 'http://127.0.0.1:3410',
    runtimeOrigin: 'http://127.0.0.2:3412',
  });
  assert.equal(Object.keys(headers).length, 10);
  assert.match(headers['Content-Security-Policy'] ?? '', /sandbox allow-scripts/u);
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'cross-origin');
  for (const forbidden of ['Set-Cookie', 'Access-Control-Allow-Origin', 'X-Frame-Options']) {
    assert.equal(Object.hasOwn(headers, forbidden), false);
  }
});

test('runtime routes enforce Host, GET, and the fixed allowlist', () => {
  const outerPath = `/assets/outer.${HASH}.js`;
  const assets: ArtifactRuntimeAssetsV1 = {
    runnerHtml: new TextEncoder().encode('<!doctype html>'),
    entries: new Map([[outerPath, {
      logicalName: 'outer', path: outerPath, sha256: HASH, byteLength: 1,
      mediaType: 'application/javascript; charset=utf-8', bytes: new Uint8Array([1]),
    }]]),
  };
  const request = (method: string, path: string, host = '127.0.0.2:3412') => routeArtifactRuntimeRequestV1({ method, path, host, topology: topology(), assets });
  assert.equal(request('GET', '/healthz').status, 200);
  assert.equal(request('GET', '/runner').status, 200);
  assert.equal(request('GET', outerPath).status, 200);
  assert.equal(request('GET', '/assets/unknown.js').status, 404);
  assert.equal(request('POST', '/runner').status, 405);
  assert.equal(request('GET', '/runner', 'localhost:3412').status, 421);
});
