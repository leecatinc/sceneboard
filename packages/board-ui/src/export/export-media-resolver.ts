import { sha256HexV1 } from '@sceneboard/artifact-runtime/package';
import { collectDocumentNodesV2, MAX_MEDIA_PIXELS } from '@sceneboard/board-schema';
import { EXPORT_TRUSTED_IMAGE_URL_V1, type MediaResolverV1 } from '../renderer/renderer-types.js';
import type { ExportArtifactPackageStoreV1 } from './ExportArtifactHost.js';
import type { ExportProjectionResourceV1, ExportProjectionV1 } from './export-types.js';

type BrokerIdentityV1 = Readonly<{ origin: string; sessionId: string }>;

const loopback = (hostname: string): boolean =>
  hostname === '[::1]' ||
  /^127(?:\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$/u.test(hostname);

const brokerIdentity = (url: string, sha256: string): BrokerIdentityV1 | null => {
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const match =
      /^\/internal\/v1\/export-render\/([A-Za-z0-9_-]{22})\/resources\/([0-9a-f]{64})$/u.exec(
        decodedPath,
      );
    if (
      parsed.protocol !== 'http:' ||
      !loopback(parsed.hostname) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      match?.[2] !== sha256
    )
      return null;
    return { origin: parsed.origin, sessionId: match[1]! };
  } catch {
    return null;
  }
};

const EXPORT_RESOURCE_MAX_COUNT_V1 = 256;
const EXPORT_RESOURCE_MAX_BYTES_V1 = 16_777_216;
const EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1 = 268_435_456;
const IMAGE_MEDIA_TYPES_V1 = ['image/png', 'image/jpeg', 'image/webp'] as const;

type MediaResourceDescriptorV1 = ExportProjectionResourceV1 & {
  usage: Extract<ExportProjectionResourceV1['usage'], { kind: 'media' }>;
  mediaType: (typeof IMAGE_MEDIA_TYPES_V1)[number];
};

type MediaEntryV1 = {
  resource: MediaResourceDescriptorV1;
  promise: Promise<void> | null;
  url: string | null;
  failed: boolean;
};

const base64 = (bytes: Uint8Array): string => {
  let encoded = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(encoded);
};

const validImageBytes = (mediaType: MediaResourceDescriptorV1['mediaType'], bytes: Uint8Array) => {
  if (mediaType === 'image/png')
    return (
      bytes.byteLength >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    );
  if (mediaType === 'image/jpeg')
    return (
      bytes.byteLength >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    );
  return (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  );
};

const certifyDecodedImage = async (url: string): Promise<void> => {
  if (typeof Image === 'undefined') return;
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (
      !Number.isSafeInteger(image.naturalWidth) ||
      image.naturalWidth < 1 ||
      !Number.isSafeInteger(image.naturalHeight) ||
      image.naturalHeight < 1 ||
      image.naturalWidth * image.naturalHeight > MAX_MEDIA_PIXELS
    )
      throw new TypeError('export media decoded dimensions are invalid');
  } finally {
    image.src = '';
  }
};

export class ExportMediaStoreV1 {
  readonly #entries = new Map<string, MediaEntryV1>();
  readonly #resources = new Map<string, MediaResourceDescriptorV1>();
  readonly #pages = new Map<string, Set<string>>();
  readonly #controller = new AbortController();
  readonly #boardId: ExportProjectionV1['boardId'];
  readonly #revisionId: ExportProjectionV1['revisionId'];
  #invalid = false;
  #disposed = false;
  #fetches = 0;

  constructor(projection: ExportProjectionV1) {
    this.#boardId = projection.boardId;
    this.#revisionId = projection.revisionId;
    const identities = projection.resources.map((resource) =>
      brokerIdentity(resource.url, resource.sha256),
    );
    const expected = identities[0] ?? null;
    const uniqueBytes = new Map<string, { bytes: number; mediaType: string }>();
    let totalBytes = 0;
    if (projection.resources.length > EXPORT_RESOURCE_MAX_COUNT_V1) this.#invalid = true;
    projection.resources.forEach((resource, index) => {
      const identity = identities[index];
      if (
        identity === undefined ||
        identity === null ||
        expected === null ||
        identity.origin !== expected.origin ||
        identity.sessionId !== expected.sessionId ||
        !Number.isSafeInteger(resource.byteLength) ||
        resource.byteLength < 1 ||
        resource.byteLength > EXPORT_RESOURCE_MAX_BYTES_V1
      )
        this.#invalid = true;
      const existingBytes = uniqueBytes.get(resource.sha256);
      if (existingBytes === undefined) {
        uniqueBytes.set(resource.sha256, {
          bytes: resource.byteLength,
          mediaType: resource.mediaType,
        });
        totalBytes += resource.byteLength;
      } else if (
        existingBytes.bytes !== resource.byteLength ||
        existingBytes.mediaType !== resource.mediaType
      )
        this.#invalid = true;
      if (
        resource.usage.kind !== 'media' ||
        !IMAGE_MEDIA_TYPES_V1.includes(resource.mediaType as (typeof IMAGE_MEDIA_TYPES_V1)[number])
      )
        return;
      const media = resource as MediaResourceDescriptorV1;
      const existing = this.#resources.get(media.usage.mediaId);
      if (
        existing !== undefined &&
        (existing.sha256 !== media.sha256 ||
          existing.url !== media.url ||
          existing.mediaType !== media.mediaType ||
          existing.byteLength !== media.byteLength)
      )
        this.#invalid = true;
      else this.#resources.set(media.usage.mediaId, media);
      const digestEntry = this.#entries.get(media.sha256);
      if (digestEntry === undefined)
        this.#entries.set(media.sha256, {
          resource: media,
          promise: null,
          url: null,
          failed: false,
        });
      else if (
        digestEntry.resource.url !== media.url ||
        digestEntry.resource.mediaType !== media.mediaType ||
        digestEntry.resource.byteLength !== media.byteLength
      )
        this.#invalid = true;
    });
    if (!Number.isSafeInteger(totalBytes) || totalBytes > EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1)
      this.#invalid = true;
    for (const item of collectDocumentNodesV2(projection.document)) {
      if (item.node.type !== 'content.image' || item.node.source.type !== 'media') continue;
      const pages = this.#pages.get(item.node.source.mediaId) ?? new Set<string>();
      pages.add(item.page.pageId);
      this.#pages.set(item.node.source.mediaId, pages);
    }
    for (const mediaId of this.#resources.keys())
      if (!this.#pages.has(mediaId)) this.#invalid = true;
  }

  async #prepare(entry: MediaEntryV1): Promise<void> {
    if (this.#disposed) throw new TypeError('export media store is disposed');
    if (this.#invalid || entry.failed) throw new TypeError('export media projection is invalid');
    if (entry.url !== null) return;
    entry.promise ??= (async () => {
      let bytes: Uint8Array | null = null;
      try {
        this.#fetches += 1;
        const response = await fetch(entry.resource.url, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: this.#controller.signal,
        });
        if (
          response.status !== 200 ||
          response.headers.get('content-type') !== entry.resource.mediaType
        )
          throw new TypeError('export media response is invalid');
        bytes = new Uint8Array(await response.arrayBuffer());
        if (
          bytes.byteLength !== entry.resource.byteLength ||
          !validImageBytes(entry.resource.mediaType, bytes) ||
          (await sha256HexV1(bytes)) !== entry.resource.sha256
        )
          throw new TypeError('export media certification failed');
        if (this.#disposed || this.#controller.signal.aborted)
          throw new TypeError('export media store is disposed');
        const url = `data:${entry.resource.mediaType};base64,${base64(bytes)}`;
        await certifyDecodedImage(url);
        if (this.#disposed || this.#controller.signal.aborted)
          throw new TypeError('export media store is disposed');
        entry.url = url;
      } catch (error) {
        entry.failed = true;
        throw error;
      } finally {
        bytes?.fill(0);
      }
    })();
    return entry.promise;
  }

  async prepareAll(): Promise<void> {
    if (this.#invalid) throw new TypeError('export media projection is invalid');
    await Promise.all([...this.#entries.values()].map((entry) => this.#prepare(entry)));
  }

  resolve(input: Extract<Parameters<MediaResolverV1>[0], { mediaId: unknown }>) {
    const resource = this.#resources.get(input.mediaId);
    const trust =
      resource === undefined
        ? undefined
        : { [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'broker' as const, sha256: resource.sha256 } };
    if (
      this.#disposed ||
      this.#invalid ||
      input.boardId !== this.#boardId ||
      input.revisionId !== this.#revisionId ||
      resource === undefined ||
      !this.#pages.get(input.mediaId)?.has(input.pageId)
    )
      return { error: 'unavailable' as const, ...trust };
    const entry = this.#entries.get(resource.sha256);
    if (entry === undefined || entry.failed) return { error: 'unavailable' as const, ...trust };
    if (entry.url === null) return { error: 'pending' as const, ...trust };
    return { url: entry.url, ...trust };
  }

  inspectV1(): Readonly<{
    valid: boolean;
    fetches: number;
    uniqueMedia: number;
    ready: number;
    disposed: boolean;
  }> {
    return Object.freeze({
      valid: !this.#invalid,
      fetches: this.#fetches,
      uniqueMedia: this.#entries.size,
      ready: [...this.#entries.values()].filter((entry) => entry.url !== null).length,
      disposed: this.#disposed,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller.abort();
    for (const entry of this.#entries.values()) {
      entry.url = null;
      entry.promise = null;
    }
    this.#entries.clear();
    this.#resources.clear();
    this.#pages.clear();
  }
}

export const createExportMediaResolverV1 = (
  projection: ExportProjectionV1,
  packageStore?: ExportArtifactPackageStoreV1,
  mediaStore?: ExportMediaStoreV1,
): MediaResolverV1 => {
  const identities = projection.resources.map((resource) =>
    brokerIdentity(resource.url, resource.sha256),
  );
  const expected = identities[0];
  const trustedProjection =
    expected !== undefined &&
    expected !== null &&
    identities.every(
      (identity) =>
        identity !== null &&
        identity.origin === expected.origin &&
        identity.sessionId === expected.sessionId,
    );
  const resources = new Map(
    projection.resources
      .filter(
        (
          resource,
        ): resource is typeof resource & {
          usage: Extract<typeof resource.usage, { kind: 'media' }>;
        } => resource.usage.kind === 'media',
      )
      .map((resource) => [resource.usage.mediaId, resource]),
  );
  return (input) => {
    if (input.boardId !== projection.boardId || input.revisionId !== projection.revisionId)
      return { error: 'unavailable' };
    if ('artifact' in input) {
      if (packageStore === undefined) return { error: 'unavailable' };
      return trustedProjection
        ? packageStore.resolveArtifactImage(input)
        : {
            error: 'unavailable',
            [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'artifact', sha256: input.sha256 },
          };
    }
    if (!trustedProjection || mediaStore === undefined) return { error: 'unavailable' };
    const resource = resources.get(input.mediaId);
    if (
      resource === undefined ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(resource.mediaType)
    )
      return { error: 'unavailable' };
    return mediaStore.resolve(input);
  };
};
