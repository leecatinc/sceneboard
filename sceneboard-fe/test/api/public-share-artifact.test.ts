import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  ArtifactManifestParserV1,
  PublicShareStateParserV1,
  type ArtifactReferenceV1,
} from '@sceneboard/board-schema';

import {
  PUBLIC_ARTIFACT_ACTIVE_HANDSHAKES_MAX_V1,
  PublicArtifactPackageStoreV1,
} from '../../lib/api/public-share-artifact.js';

const contextId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const artifact = {
  artifactId: 'artifact_one',
  versionId: 'version_one',
} as ArtifactReferenceV1;
const packageUrl =
  '/api/v1/public/shares/share_01/revisions/revision_01/g/3/4/artifacts/' +
  `${artifact.artifactId}/versions/${artifact.versionId}/package?contextId=${contextId}`;

const readyInput = {
  state: 'ready',
  projection: {
    shareId: 'share_01',
    boardId: 'board_01',
    revisionId: 'revision_01',
    publicationGeneration: 3,
    accessGeneration: 4,
    title: 'Public artifact board',
    document: {
      schemaVersion: 2,
      defaultPageId: 'page_01',
      pages: [
        {
          pageId: 'page_01',
          title: 'Artifact',
          displayMode: 'fit-page',
          scene: {
            protocolVersion: 1,
            type: 'scene',
            root: {
              id: 'artifact_node',
              type: 'content.artifact',
              artifact,
              fallbackText: 'KitCatHub artifact',
            },
          },
        },
      ],
    },
    artifacts: [{ ...artifact, status: 'ready', packageUrl }],
    media: [],
  },
  context: { contextId, validUntil: '2026-08-05T04:00:00.000Z' },
} as const;

const readyParsed = PublicShareStateParserV1.parse(readyInput);
assert.equal(readyParsed.ok, true);
if (!readyParsed.ok || readyParsed.data.value.state !== 'ready')
  throw new TypeError('public artifact fixture is invalid');
const ready = readyParsed.data.value;

const bytesV1 = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256V1 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const packageFixtureV1 = (
  identity: ArtifactReferenceV1 = artifact,
  html = '<main>KitCatHub</main>',
): Uint8Array => {
  const resource = bytesV1(html);
  const manifest = ArtifactManifestParserV1.parse({
    protocolVersion: 1,
    type: 'artifact.manifest',
    artifact: identity,
    entryPath: 'index.html',
    resources: [
      {
        path: 'index.html',
        mediaType: 'text/html',
        sha256: sha256V1(resource),
        byteLength: resource.byteLength,
      },
    ],
    requestedCapabilities: [],
  });
  assert.equal(manifest.ok, true);
  if (!manifest.ok) throw new TypeError('artifact package fixture is invalid');
  const path = bytesV1('index.html');
  const bytes = new Uint8Array(
    8 +
      4 +
      manifest.data.canonicalBytes.byteLength +
      2 +
      2 +
      path.byteLength +
      4 +
      resource.byteLength,
  );
  const view = new DataView(bytes.buffer);
  bytes.set(bytesV1('LCARTV1\0'));
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

const responseV1 = (body = packageFixtureV1(), headers: Record<string, string> = {}): Response =>
  new Response(Uint8Array.from(body).buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.leecat.artifact-package.v1',
      'Cache-Control': 'private,no-store',
      'Content-Length': String(body.byteLength),
      ...headers,
    },
  });

test('public workflow graph packages prefer fill while other artifacts retain fit-page', async () => {
  for (const fixture of [
    { html: '<main>KitCatHub</main>', expected: 'fit-page' },
    {
      html: '<main class="sb-workflow-graph" data-sb-workflow-graph="v1"></main>',
      expected: 'fill',
    },
  ] as const) {
    const store = new PublicArtifactPackageStoreV1(ready, {
      apiOrigin: 'https://sceneboard.example',
      fetcher: async () => responseV1(packageFixtureV1(artifact, fixture.html)),
    });
    const handle = store.open(artifact);
    const controller = new AbortController();
    assert.equal(handle.preferredViewMode(), null);
    await handle.load.readMetadata({
      boardId: ready.projection.boardId,
      artifact,
      signal: controller.signal,
    });
    assert.equal(handle.preferredViewMode(), fixture.expected);
    const bytes = await handle.load.readPackage({
      boardId: ready.projection.boardId,
      artifact,
      signal: controller.signal,
    });
    handle.load.releasePackage?.(bytes);
    store.dispose();
  }
});

test('public artifact loader certifies the exact tuple and zeroes released package bytes', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let fetchReceiverWasGlobalThis = false;
  const store = new PublicArtifactPackageStoreV1(ready, {
    apiOrigin: 'https://sceneboard.example',
    fetcher: async function (url, init) {
      fetchReceiverWasGlobalThis = (this as unknown) === globalThis;
      requests.push({ url: String(url), init });
      return responseV1();
    },
  });
  const handle = store.open(artifact);
  const controller = new AbortController();
  const metadata = await handle.load.readMetadata({
    boardId: ready.projection.boardId,
    artifact,
    signal: controller.signal,
  });
  assert.equal(metadata.manifest.artifact.versionId, artifact.versionId);
  const bytes = await handle.load.readPackage({
    boardId: ready.projection.boardId,
    artifact,
    signal: controller.signal,
  });
  const confirmed = await handle.load.readMetadata({
    boardId: ready.projection.boardId,
    artifact,
    signal: controller.signal,
  });
  assert.equal(confirmed.manifest.artifact.artifactId, artifact.artifactId);
  assert.equal(requests[0]?.url, `https://sceneboard.example${packageUrl}`);
  assert.equal(requests[0]?.init?.credentials, 'include');
  assert.equal(requests[0]?.init?.cache, 'no-store');
  assert.equal(requests[0]?.init?.redirect, 'error');
  assert.equal(fetchReceiverWasGlobalThis, true);
  assert.equal(store.inspectV1().active, 1);
  await assert.rejects(
    handle.load.readMetadata({
      boardId: 'board_other' as never,
      artifact,
      signal: controller.signal,
    }),
  );
  handle.load.releasePackage?.(bytes);
  assert.equal(
    bytes.every((value) => value === 0),
    true,
  );
  assert.deepEqual(store.inspectV1(), { active: 0, peak: 1, waiting: 0, handles: 0 });
  store.dispose();
});

test('public artifact store renews same-tuple authorization without replacing an unopened handle', async () => {
  const renewedContextId = `${'B'.repeat(42)}A`;
  const renewedPackageUrl = packageUrl.replace(contextId, renewedContextId);
  const renewedParsed = PublicShareStateParserV1.parse({
    ...ready,
    projection: {
      ...ready.projection,
      artifacts: [{ ...artifact, status: 'ready', packageUrl: renewedPackageUrl }],
    },
    context: { ...ready.context, contextId: renewedContextId },
  });
  assert.equal(renewedParsed.ok, true);
  if (!renewedParsed.ok || renewedParsed.data.value.state !== 'ready')
    throw new TypeError('renewed public artifact fixture is invalid');
  const renewed = renewedParsed.data.value;

  const requests: string[] = [];
  const store = new PublicArtifactPackageStoreV1(ready, {
    apiOrigin: 'https://sceneboard.example',
    fetcher: async (url) => {
      requests.push(String(url));
      return responseV1();
    },
  });
  const handle = store.open(artifact);
  store.renew(renewed);
  await handle.load.readMetadata({
    boardId: ready.projection.boardId,
    artifact,
    signal: new AbortController().signal,
  });
  assert.deepEqual(requests, [`https://sceneboard.example${renewedPackageUrl}`]);
  assert.throws(() =>
    store.renew({
      ...renewed,
      projection: {
        ...renewed.projection,
        accessGeneration: renewed.projection.accessGeneration + 1,
      },
    }),
  );
  store.dispose();
});

test('disposing immediately after slot acquisition releases the handshake slot', async () => {
  let fetches = 0;
  const store = new PublicArtifactPackageStoreV1(ready, {
    apiOrigin: 'https://sceneboard.example',
    fetcher: async () => {
      fetches += 1;
      return responseV1();
    },
  });
  const handle = store.open(artifact);
  const loading = handle.load.readMetadata({
    boardId: ready.projection.boardId,
    artifact,
    signal: new AbortController().signal,
  });
  handle.dispose();
  await assert.rejects(loading, { name: 'AbortError' });
  assert.equal(fetches, 0);
  assert.deepEqual(store.inspectV1(), { active: 0, peak: 1, waiting: 0, handles: 0 });
  store.dispose();
});

test('public artifact loader rejects malformed response and package identity inputs', async () => {
  const cases: Array<() => Response> = [
    () => new Response(null, { status: 404 }),
    () => responseV1(packageFixtureV1(), { 'Content-Type': 'application/json' }),
    () => responseV1(packageFixtureV1(), { 'Cache-Control': 'public,max-age=60' }),
    () => responseV1(packageFixtureV1(), { 'Content-Length': '1' }),
    () => {
      const corrupt = packageFixtureV1();
      corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
      return responseV1(corrupt);
    },
    () =>
      responseV1(
        packageFixtureV1({
          artifactId: 'artifact_two',
          versionId: 'version_two',
        } as ArtifactReferenceV1),
      ),
  ];
  for (const makeResponse of cases) {
    const store = new PublicArtifactPackageStoreV1(ready, {
      apiOrigin: 'https://sceneboard.example',
      fetcher: async () => makeResponse(),
    });
    const handle = store.open(artifact);
    await assert.rejects(
      handle.load.readMetadata({
        boardId: ready.projection.boardId,
        artifact,
        signal: new AbortController().signal,
      }),
    );
    assert.equal(store.inspectV1().active, 0);
    store.dispose();
  }
});

test('public artifact loader holds at most two package handshakes and releases queued work', async () => {
  const responders: Array<(response: Response) => void> = [];
  let fetches = 0;
  const store = new PublicArtifactPackageStoreV1(ready, {
    apiOrigin: 'https://sceneboard.example',
    fetcher: async () => {
      fetches += 1;
      return new Promise<Response>((resolve) => responders.push(resolve));
    },
  });
  const handles = [store.open(artifact), store.open(artifact), store.open(artifact)];
  const controllers = handles.map(() => new AbortController());
  const metadata = handles.map((handle, index) =>
    handle.load.readMetadata({
      boardId: ready.projection.boardId,
      artifact,
      signal: controllers[index]!.signal,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, PUBLIC_ARTIFACT_ACTIVE_HANDSHAKES_MAX_V1);
  assert.deepEqual(store.inspectV1(), { active: 2, peak: 2, waiting: 1, handles: 3 });
  responders.shift()?.(responseV1());
  await metadata[0];
  const firstBytes = await handles[0]!.load.readPackage({
    boardId: ready.projection.boardId,
    artifact,
    signal: controllers[0]!.signal,
  });
  handles[0]!.load.releasePackage?.(firstBytes);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 3);
  responders.shift()?.(responseV1());
  responders.shift()?.(responseV1());
  await Promise.all(metadata.slice(1));
  const retained = await Promise.all(
    handles.slice(1).map((handle, index) =>
      handle.load.readPackage({
        boardId: ready.projection.boardId,
        artifact,
        signal: controllers[index + 1]!.signal,
      }),
    ),
  );
  store.dispose();
  assert.equal(
    retained.every((bytes) => bytes.every((value) => value === 0)),
    true,
  );
  assert.deepEqual(store.inspectV1(), { active: 0, peak: 2, waiting: 0, handles: 0 });
});
