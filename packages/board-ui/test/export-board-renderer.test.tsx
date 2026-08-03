import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  ArtifactManifestParserV1,
  BoardDocumentParserV3,
  presentationFormatDescriptorV1,
} from '@sceneboard/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createExportMediaResolverV1,
  EXPORT_ARTIFACT_TRANSFER_MAX_BYTES_V1,
  EXPORT_ARTIFACT_TRANSFER_MAX_COPIES_V1,
  ExportMediaStoreV1,
  ExportArtifactPackageStoreV1,
  ExportBoardRenderer,
  type ExportProjectionV1,
} from '../src/export/index.js';
import { EXPORT_TRUSTED_IMAGE_URL_V1 } from '../src/renderer/renderer-types.js';

const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const artifactPackage = (): Uint8Array => {
  const image = bytes('verified-image');
  const manifest = ArtifactManifestParserV1.parse({
    protocolVersion: 1,
    type: 'artifact.manifest',
    artifact: { artifactId: 'artifact_one', versionId: 'version_one' },
    entryPath: 'preview.png',
    resources: [
      {
        path: 'preview.png',
        mediaType: 'image/png',
        sha256: hex(image),
        byteLength: image.byteLength,
      },
    ],
    requestedCapabilities: [],
  });
  assert.equal(manifest.ok, true);
  if (!manifest.ok) throw new TypeError('artifact fixture is invalid');
  const path = bytes('preview.png');
  const output = new Uint8Array(
    8 +
      4 +
      manifest.data.canonicalBytes.byteLength +
      2 +
      2 +
      path.byteLength +
      4 +
      image.byteLength,
  );
  const view = new DataView(output.buffer);
  output.set(bytes('LCARTV1\0'));
  let offset = 8;
  view.setUint32(offset, manifest.data.canonicalBytes.byteLength, false);
  offset += 4;
  output.set(manifest.data.canonicalBytes, offset);
  offset += manifest.data.canonicalBytes.byteLength;
  view.setUint16(offset, 1, false);
  offset += 2;
  view.setUint16(offset, path.byteLength, false);
  offset += 2;
  output.set(path, offset);
  offset += path.byteLength;
  view.setUint32(offset, image.byteLength, false);
  offset += 4;
  output.set(image, offset);
  return output;
};

const document = BoardDocumentParserV3.parse({
  schemaVersion: 3,
  format: 'wide_16_9',
  defaultPageId: 'page_1',
  pages: [
    {
      pageId: 'page_1',
      title: 'First',
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: { id: 'first', type: 'content.markdown', markdown: 'First export page' },
      },
    },
    {
      pageId: 'page_2',
      title: 'Second',
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: { id: 'second', type: 'content.markdown', markdown: 'Second export page' },
      },
    },
  ],
});
if (!document.ok) throw new TypeError('export renderer fixture is invalid');

const projection: ExportProjectionV1 = {
  schemaVersion: 1,
  boardId: 'AAECAwQFBgcICQoLDA0ODw' as ExportProjectionV1['boardId'],
  revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ExportProjectionV1['revisionId'],
  revisionNumber: 7,
  document: document.data.value,
  format: presentationFormatDescriptorV1('wide_16_9'),
  resources: [
    {
      sha256: 'a'.repeat(64),
      mediaType: 'image/png',
      byteLength: 8,
      url: `http://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${'a'.repeat(64)}`,
      usage: { kind: 'media', mediaId: 'media_1' as never },
    },
  ],
};

const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const mediaDocument = BoardDocumentParserV3.parse({
  schemaVersion: 3,
  format: 'wide_16_9',
  defaultPageId: 'page_1',
  pages: ['page_1', 'page_2'].map((pageId, index) => ({
    pageId,
    title: '',
    displayMode: 'fit-page',
    scene: {
      protocolVersion: 1,
      type: 'scene',
      root: {
        id: `media_${index.toString()}`,
        type: 'content.image',
        source: { type: 'media', mediaId: 'media_1' },
        alt: 'Media',
        fit: 'contain',
      },
    },
  })),
});
if (!mediaDocument.ok) throw new TypeError('media projection fixture is invalid');
const mediaProjection: ExportProjectionV1 = {
  ...projection,
  document: mediaDocument.data.value,
  resources: [
    {
      sha256: hex(pngBytes),
      mediaType: 'image/png',
      byteLength: pngBytes.byteLength,
      url: `http://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${hex(pngBytes)}`,
      usage: { kind: 'media', mediaId: 'media_1' as never },
    },
  ],
};

test('export renderer selects exactly one ordered page at the frozen viewport', () => {
  const html = renderToStaticMarkup(
    <ExportBoardRenderer
      projection={projection}
      pageIndex={1}
      runtimeOrigin="http://127.0.0.2:3412"
    />,
  );
  assert.match(html, /data-export-page="1"/u);
  assert.match(html, /width:1600px;height:900px/u);
  assert.match(html, /Second export page/u);
  assert.doesNotMatch(html, /First export page/u);
  assert.match(
    renderToStaticMarkup(
      <ExportBoardRenderer
        projection={projection}
        pageIndex={2}
        runtimeOrigin="http://127.0.0.2:3412"
      />,
    ),
    /data-export-unsupported="page"/u,
  );
});

test('export media store fetches one certified representation across occurrences and page switches', async () => {
  const priorFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(pngBytes.slice(), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  };
  const store = new ExportMediaStoreV1(mediaProjection);
  try {
    const resolve = createExportMediaResolverV1(mediaProjection, undefined, store);
    const pending = resolve({
      boardId: mediaProjection.boardId,
      revisionId: mediaProjection.revisionId,
      pageId: mediaProjection.document.pages[0]!.pageId,
      mediaId: 'media_1' as never,
    });
    assert.equal('error' in pending && pending.error, 'pending');
    await store.prepareAll();
    const accepted = resolve({
      boardId: mediaProjection.boardId,
      revisionId: mediaProjection.revisionId,
      pageId: mediaProjection.document.pages[0]!.pageId,
      mediaId: 'media_1' as never,
    });
    const repeated = resolve({
      boardId: mediaProjection.boardId,
      revisionId: mediaProjection.revisionId,
      pageId: mediaProjection.document.pages[1]!.pageId,
      mediaId: 'media_1' as never,
    });
    assert.equal('url' in accepted && accepted.url.startsWith('data:image/png;base64,'), true);
    assert.equal('url' in repeated && repeated.url, 'url' in accepted && accepted.url);
    assert.equal('url' in accepted && accepted[EXPORT_TRUSTED_IMAGE_URL_V1]?.kind, 'broker');
    assert.equal(fetches, 1);
    assert.deepEqual(store.inspectV1(), {
      valid: true,
      fetches: 1,
      uniqueMedia: 1,
      ready: 1,
      disposed: false,
    });
    assert.deepEqual(
      resolve({
        boardId: mediaProjection.boardId,
        revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never,
        pageId: mediaProjection.document.pages[0]!.pageId,
        mediaId: 'media_1' as never,
      }),
      { error: 'unavailable' },
    );
    assert.equal(
      'error' in
        resolve({
          boardId: mediaProjection.boardId,
          revisionId: mediaProjection.revisionId,
          pageId: 'page_unowned' as never,
          mediaId: 'media_1' as never,
        }),
      true,
    );
    store.dispose();
    assert.equal(store.inspectV1().disposed, true);
  } finally {
    store.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('export media resolver remains bound to the immutable board and revision tuple', async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(pngBytes.slice(), { status: 200, headers: { 'content-type': 'image/png' } });
  const store = new ExportMediaStoreV1(mediaProjection);
  await store.prepareAll();
  const resolve = createExportMediaResolverV1(mediaProjection, undefined, store);
  const accepted = resolve({
    boardId: mediaProjection.boardId,
    revisionId: mediaProjection.revisionId,
    pageId: mediaProjection.document.pages[0]!.pageId,
    mediaId: 'media_1' as never,
  });
  assert.equal('url' in accepted && accepted.url.startsWith('data:image/png;base64,'), true);
  assert.equal('url' in accepted && accepted[EXPORT_TRUSTED_IMAGE_URL_V1]?.kind, 'broker');
  assert.deepEqual(
    resolve({
      boardId: mediaProjection.boardId,
      revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never,
      pageId: mediaProjection.document.pages[0]!.pageId,
      mediaId: 'media_1' as never,
    }),
    { error: 'unavailable' },
  );
  store.dispose();
  globalThis.fetch = priorFetch;
});

test('export media resolver rejects wrong-origin, query, fragment, and malformed URL resources', () => {
  for (const url of [
    `https://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${'a'.repeat(64)}`,
    `${projection.resources[0]!.url}?download=1`,
    `${projection.resources[0]!.url}#fragment`,
    `http://127.0.0.1:3411/internal/v1/export-render/%E0%A4%A/resources/${'a'.repeat(64)}`,
  ]) {
    const malformed = {
      ...mediaProjection,
      resources: [{ ...mediaProjection.resources[0]!, url }],
    };
    const store = new ExportMediaStoreV1(malformed);
    const resolve = createExportMediaResolverV1(malformed, undefined, store);
    assert.deepEqual(
      resolve({
        boardId: mediaProjection.boardId,
        revisionId: mediaProjection.revisionId,
        pageId: mediaProjection.document.pages[0]!.pageId,
        mediaId: 'media_1' as never,
      }),
      { error: 'unavailable' },
    );
    assert.equal(store.inspectV1().valid, false);
    store.dispose();
  }
});

test('500 artifact occurrences reuse one package and cap simultaneous owned transfer copies', async () => {
  const packageBytes = artifactPackage();
  const packageProjection = {
    ...projection,
    resources: [
      {
        sha256: hex(packageBytes),
        mediaType: 'application/vnd.sceneboard.artifact-package+zip' as const,
        byteLength: packageBytes.byteLength,
        url: `http://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${hex(packageBytes)}`,
        usage: {
          kind: 'artifact' as const,
          artifactId: 'artifact_one' as never,
          versionId: 'version_one' as never,
        },
      },
    ],
  } satisfies ExportProjectionV1;
  const priorFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(packageBytes.slice(), {
      status: 200,
      headers: { 'content-type': 'application/vnd.sceneboard.artifact-package+zip' },
    });
  };
  try {
    const store = new ExportArtifactPackageStoreV1(packageProjection);
    const artifact = { artifactId: 'artifact_one', versionId: 'version_one' } as never;
    const ports = Array.from({ length: 500 }, () => store.loadPort(artifact));
    const signal = new AbortController().signal;
    const metadataResults = await Promise.all(
      ports.flatMap((port) => [
        port.readMetadata({ boardId: projection.boardId, artifact, signal }),
        port.readMetadata({ boardId: projection.boardId, artifact, signal }),
      ]),
    );
    const metadata = metadataResults[0];
    const confirmation = metadataResults[1];
    const packageOne = await ports[0]!.readPackage({
      boardId: projection.boardId,
      artifact,
      signal,
    });
    const packageTwo = await ports[1]!.readPackage({
      boardId: projection.boardId,
      artifact,
      signal,
    });
    let thirdResolved = false;
    const packageThreePromise = ports[2]!
      .readPackage({ boardId: projection.boardId, artifact, signal })
      .then((value) => {
        thirdResolved = true;
        return value;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(thirdResolved, false);
    assert.equal(store.inspectTransfersV1().waiting, 1);
    ports[0]!.releasePackage?.(packageOne);
    const packageThree = await packageThreePromise;
    assert.ok(metadata !== undefined && 'manifest' in metadata);
    assert.ok(confirmation !== undefined && 'manifest' in confirmation);
    assert.ok(packageOne instanceof Uint8Array);
    assert.ok(packageTwo instanceof Uint8Array);
    assert.equal(fetches, 1);
    assert.deepEqual(metadata.manifest, confirmation.manifest);
    assert.notEqual(packageOne.buffer, packageTwo.buffer);
    assert.equal(
      packageOne.every((value) => value === 0),
      true,
    );
    assert.notEqual(packageTwo[0], 0);
    assert.deepEqual(store.inspectTransfersV1(), {
      activeCopies: 2,
      activeBytes: packageBytes.byteLength * 2,
      peakCopies: 2,
      peakBytes: packageBytes.byteLength * 2,
      waiting: 0,
    });
    assert.ok(store.inspectTransfersV1().peakCopies <= EXPORT_ARTIFACT_TRANSFER_MAX_COPIES_V1);
    assert.ok(store.inspectTransfersV1().peakBytes <= EXPORT_ARTIFACT_TRANSFER_MAX_BYTES_V1);
    ports[1]!.releasePackage?.(packageTwo);
    ports[2]!.releasePackage?.(packageThree);
    assert.equal(store.inspectTransfersV1().activeCopies, 0);
    await store.prepareAll();
    assert.equal(fetches, 1);
    const resolve = createExportMediaResolverV1(packageProjection, store);
    const image = resolve({
      boardId: projection.boardId,
      revisionId: projection.revisionId,
      pageId: projection.document.pages[0]!.pageId,
      artifact,
      path: 'preview.png',
      sha256: hex(bytes('verified-image')),
    });
    assert.equal('url' in image && image.url.startsWith('data:image/png;base64,'), true);
    assert.equal('url' in image && image[EXPORT_TRUSTED_IMAGE_URL_V1]?.kind, 'artifact');
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      ports[0]!.readMetadata({ boardId: projection.boardId, artifact, signal: aborted.signal }),
      /Aborted/u,
    );
    store.dispose();
    await assert.rejects(
      ports[0]!.readPackage({
        boardId: projection.boardId,
        artifact,
        signal: new AbortController().signal,
      }),
      /disposed/u,
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});

const mediaInventoryProjection = (
  byteLengths: readonly number[],
  options: { sessionId?: string; duplicateMediaId?: boolean } = {},
): ExportProjectionV1 => {
  const resources = byteLengths.map((byteLength, index) => {
    const sha256 = (index + 1).toString(16).padStart(64, '0');
    return {
      sha256,
      mediaType: 'image/png' as const,
      byteLength,
      url: `http://127.0.0.1:3411/internal/v1/export-render/${options.sessionId ?? 's'.repeat(22)}/resources/${sha256}`,
      usage: {
        kind: 'media' as const,
        mediaId: (options.duplicateMediaId ? 'media_0' : `media_${index.toString()}`) as never,
      },
    };
  });
  return {
    ...projection,
    document: {
      ...projection.document,
      defaultPageId: 'page_inventory' as never,
      pages: [
        {
          pageId: 'page_inventory',
          title: '',
          displayMode: 'fit-page',
          scene: {
            protocolVersion: 1,
            type: 'scene',
            root: {
              id: 'root',
              type: 'layout.canvas',
              width: 1,
              height: 1,
              children: resources.map((resource, index) => ({
                node: {
                  id: `node_${index.toString()}`,
                  type: 'content.image',
                  source: { type: 'media', mediaId: resource.usage.mediaId },
                  alt: '',
                  fit: 'contain',
                },
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                zIndex: index,
              })),
            },
          },
        },
      ],
    } as never,
    resources,
  };
};

test('export media admission preserves exact request and byte boundaries and rejects +1', () => {
  const countBoundary = new ExportMediaStoreV1(
    mediaInventoryProjection(Array.from({ length: 256 }, () => 1)),
  );
  assert.equal(countBoundary.inspectV1().valid, true);
  countBoundary.dispose();
  const countExceeded = new ExportMediaStoreV1(
    mediaInventoryProjection(Array.from({ length: 257 }, () => 1)),
  );
  assert.equal(countExceeded.inspectV1().valid, false);
  countExceeded.dispose();

  const byteBoundary = new ExportMediaStoreV1(
    mediaInventoryProjection(Array.from({ length: 16 }, () => 16_777_216)),
  );
  assert.equal(byteBoundary.inspectV1().valid, true);
  byteBoundary.dispose();
  const byteExceeded = new ExportMediaStoreV1(
    mediaInventoryProjection([...Array.from({ length: 16 }, () => 16_777_216), 1]),
  );
  assert.equal(byteExceeded.inspectV1().valid, false);
  byteExceeded.dispose();
});

test('export media certification rejects response, digest, type, length, image, and session drift', async () => {
  const valid = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const invalid = Uint8Array.from({ length: valid.byteLength }, () => 0);
  const exactBase = mediaInventoryProjection([valid.byteLength]);
  const exact: ExportProjectionV1 = {
    ...exactBase,
    resources: [
      {
        ...exactBase.resources[0]!,
        sha256: hex(valid),
        url: `http://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${hex(valid)}`,
      },
    ],
  };
  const priorFetch = globalThis.fetch;
  const scenarios = [
    { name: 'status', status: 201, type: 'image/png', body: valid, projection: exact },
    { name: 'type', status: 200, type: 'image/jpeg', body: valid, projection: exact },
    {
      name: 'length',
      status: 200,
      type: 'image/png',
      body: valid.subarray(0, 8),
      projection: exact,
    },
    {
      name: 'digest',
      status: 200,
      type: 'image/png',
      body: Uint8Array.from([...valid.subarray(0, 11), 1]),
      projection: exact,
    },
    {
      name: 'invalid image',
      status: 200,
      type: 'image/png',
      body: invalid,
      projection: {
        ...exact,
        resources: [
          {
            ...exact.resources[0]!,
            sha256: hex(invalid),
            url: `http://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${hex(invalid)}`,
          },
        ],
      },
    },
  ];
  try {
    for (const scenario of scenarios) {
      globalThis.fetch = async () =>
        new Response(scenario.body.slice(), {
          status: scenario.status,
          headers: { 'content-type': scenario.type },
        });
      const store = new ExportMediaStoreV1(scenario.projection);
      await assert.rejects(store.prepareAll(), /export media/u, scenario.name);
      assert.equal(store.inspectV1().ready, 0);
      store.dispose();
    }
  } finally {
    globalThis.fetch = priorFetch;
  }

  const conflicting = new ExportMediaStoreV1(
    mediaInventoryProjection([1, 1], { duplicateMediaId: true }),
  );
  assert.equal(conflicting.inspectV1().valid, false);
  conflicting.dispose();
  const isolatedBase = mediaInventoryProjection([1]);
  const isolated: ExportProjectionV1 = {
    ...isolatedBase,
    resources: [
      {
        ...isolatedBase.resources[0]!,
        url: isolatedBase.resources[0]!.url.replace('s'.repeat(22), 't'.repeat(22)),
      },
    ],
  };
  const mixedSession = new ExportMediaStoreV1({
    ...isolated,
    resources: [...isolated.resources, mediaInventoryProjection([1]).resources[0]!],
  });
  assert.equal(mixedSession.inspectV1().valid, false);
  mixedSession.dispose();
});

test('disposing an in-flight export media store aborts and exposes no representation', async () => {
  const priorFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  const store = new ExportMediaStoreV1(mediaProjection);
  const preparing = store.prepareAll();
  store.dispose();
  await assert.rejects(preparing, /Aborted/u);
  assert.equal(aborted, true);
  assert.deepEqual(store.inspectV1(), {
    valid: true,
    fetches: 1,
    uniqueMedia: 0,
    ready: 0,
    disposed: true,
  });
  globalThis.fetch = priorFetch;
});
