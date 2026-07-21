import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ArtifactManifestParserV1 } from '@sceneboard/board-schema';

import { decodeArtifactNetworkResultV1, decodeArtifactPackageV1 } from '../src/package/index.js';

const artifactBytes = (source: string): Uint8Array => new TextEncoder().encode(source);
const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const packageFixture = (): Uint8Array => {
  const resource = artifactBytes('<main>SceneBoard</main>');
  const manifest = ArtifactManifestParserV1.parse({
    protocolVersion: 1,
    type: 'artifact.manifest',
    artifact: { artifactId: 'artifact_one', versionId: 'version_one' },
    entryPath: 'index.html',
    resources: [
      {
        path: 'index.html',
        mediaType: 'text/html',
        sha256: hex(resource),
        byteLength: resource.byteLength,
      },
    ],
    requestedCapabilities: [],
  });
  assert.equal(manifest.ok, true);
  if (!manifest.ok) throw new TypeError('fixture manifest failed');
  const path = artifactBytes('index.html');
  const total =
    8 +
    4 +
    manifest.data.canonicalBytes.byteLength +
    2 +
    2 +
    path.byteLength +
    4 +
    resource.byteLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(artifactBytes('LCARTV1\0'), 0);
  let offset = 8;
  view.setUint32(offset, manifest.data.canonicalBytes.byteLength, false);
  offset += 4;
  bytes.set(manifest.data.canonicalBytes, offset);
  offset += manifest.data.canonicalBytes.byteLength;
  view.setUint16(offset, 1, false);
  offset += 2;
  view.setUint16(offset, path.byteLength, false);
  offset += 2;
  bytes.set(path, offset);
  offset += path.byteLength;
  view.setUint32(offset, resource.byteLength, false);
  offset += 4;
  bytes.set(resource, offset);
  return bytes;
};

test('package decoder certifies canonical manifest, order, pair, and digests', async () => {
  const bytes = packageFixture();
  const decoded = await decodeArtifactPackageV1(bytes);
  assert.equal(decoded.manifest.artifact.versionId, 'version_one');
  assert.equal(decoded.resources.length, 1);
  assert.equal(new TextDecoder().decode(decoded.resources[0]?.bytes), '<main>SceneBoard</main>');
  assert.equal(decoded.packageSha256, hex(bytes));
});

test('package decoder rejects digest mutation and trailing bytes', async () => {
  const mutated = packageFixture();
  mutated[mutated.length - 1] ^= 1;
  await assert.rejects(decodeArtifactPackageV1(mutated), /certification/u);
  const trailing = new Uint8Array(packageFixture().byteLength + 1);
  trailing.set(packageFixture());
  await assert.rejects(decodeArtifactPackageV1(trailing), /trailing/u);
});

test('network-result decoder admits only bounded exact media results', () => {
  const media = artifactBytes('text/plain');
  const body = artifactBytes('ok');
  const bytes = new Uint8Array(8 + 4 + 2 + media.byteLength + 4 + body.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(artifactBytes('LCNETV1\0'));
  view.setUint32(8, 200, false);
  view.setUint16(12, media.byteLength, false);
  bytes.set(media, 14);
  view.setUint32(14 + media.byteLength, body.byteLength, false);
  bytes.set(body, 18 + media.byteLength);
  assert.equal(new TextDecoder().decode(decodeArtifactNetworkResultV1(bytes).body), 'ok');
  bytes[8] = 1;
  assert.throws(() => decodeArtifactNetworkResultV1(bytes), /certification/u);
});
