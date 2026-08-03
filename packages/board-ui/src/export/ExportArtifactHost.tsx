'use client';

import {
  decodeArtifactPackageV1,
  type DecodedArtifactPackageV1,
} from '@sceneboard/artifact-runtime/package';
import type {
  ArtifactReferenceV1,
  ArtifactRuntimeSummaryV1,
  TimestampV1,
} from '@sceneboard/board-schema';
import { ArtifactHost, type ArtifactLoadPortV1 } from '../artifact/index.js';
import {
  EXPORT_TRUSTED_IMAGE_URL_V1,
  type MediaResolverV1,
  type RendererComponentV1,
} from '../renderer/renderer-types.js';
import type { ExportProjectionResourceV1, ExportProjectionV1 } from './export-types.js';

const runtime = (artifact: ArtifactReferenceV1): ArtifactRuntimeSummaryV1 => ({
  artifact,
  status: 'ready',
  updatedAt: '1970-01-01T00:00:00.000Z' as TimestampV1,
  failure: null,
});

type ArtifactResourceDescriptorV1 = ExportProjectionResourceV1 & {
  usage: Extract<ExportProjectionResourceV1['usage'], { kind: 'artifact' }>;
};

type CertifiedPackageV1 = Readonly<{
  bytes: Uint8Array;
  decoded: DecodedArtifactPackageV1;
}>;

type PackageEntryV1 = {
  resource: ArtifactResourceDescriptorV1;
  promise: Promise<CertifiedPackageV1> | null;
  certified: CertifiedPackageV1 | null;
};

type TransferWaiterV1 = {
  bytes: number;
  signal: AbortSignal;
  resolve(): void;
  reject(error: Error): void;
  abort(): void;
};

export const EXPORT_ARTIFACT_TRANSFER_MAX_COPIES_V1 = 2;
export const EXPORT_ARTIFACT_TRANSFER_MAX_BYTES_V1 = 16_777_216;

const waitForSignal = async <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
};

const base64 = (bytes: Uint8Array): string => {
  let encoded = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(encoded);
};

export class ExportArtifactPackageStoreV1 {
  readonly #entries = new Map<string, PackageEntryV1>();
  readonly #dataUrls = new Map<string, string>();
  readonly #controller = new AbortController();
  readonly #copies = new Map<Uint8Array, number>();
  readonly #transferWaiters: TransferWaiterV1[] = [];
  #activeTransferBytes = 0;
  #reservedTransferBytes = 0;
  #reservedTransferCopies = 0;
  #peakTransferBytes = 0;
  #peakTransferCopies = 0;
  #disposed = false;

  constructor(projection: ExportProjectionV1) {
    for (const resource of projection.resources) {
      if (resource.usage.kind !== 'artifact') continue;
      const candidate = resource as ArtifactResourceDescriptorV1;
      const existing = this.#entries.get(resource.sha256);
      if (existing === undefined)
        this.#entries.set(resource.sha256, { resource: candidate, promise: null, certified: null });
      else if (
        existing.resource.url !== resource.url ||
        existing.resource.byteLength !== resource.byteLength ||
        existing.resource.mediaType !== resource.mediaType
      )
        throw new TypeError('shared artifact digest descriptor mismatch');
    }
  }

  async #certify(entry: PackageEntryV1): Promise<CertifiedPackageV1> {
    if (this.#disposed) throw new TypeError('artifact package store is disposed');
    if (entry.certified !== null) return entry.certified;
    entry.promise ??= (async () => {
      let bytes: Uint8Array | null = null;
      try {
        const response = await fetch(entry.resource.url, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: this.#controller.signal,
        });
        if (
          response.status !== 200 ||
          response.headers.get('content-type') !== 'application/vnd.sceneboard.artifact-package+zip'
        )
          throw new Error('artifact package unavailable');
        bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== entry.resource.byteLength)
          throw new Error('artifact package size mismatch');
        const decoded = await decodeArtifactPackageV1(bytes);
        if (
          decoded.packageSha256 !== entry.resource.sha256 ||
          decoded.manifest.artifact.artifactId !== entry.resource.usage.artifactId ||
          decoded.manifest.artifact.versionId !== entry.resource.usage.versionId
        )
          throw new Error('artifact package identity mismatch');
        if (this.#disposed || this.#controller.signal.aborted)
          throw new TypeError('artifact package store is disposed');
        const certified = { bytes, decoded };
        entry.certified = certified;
        return certified;
      } catch (error) {
        bytes?.fill(0);
        throw error;
      }
    })().catch((error: unknown) => {
      entry.promise = null;
      throw error;
    });
    return entry.promise;
  }

  async prepareAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => this.#certify(entry)));
  }

  async #acquireTransfer(bytes: number, signal: AbortSignal): Promise<void> {
    if (this.#disposed) throw new TypeError('artifact package store is disposed');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (bytes > EXPORT_ARTIFACT_TRANSFER_MAX_BYTES_V1)
      throw new TypeError('artifact package exceeds the transfer memory bound');
    const available = (): boolean =>
      this.#copies.size + this.#reservedTransferCopies < EXPORT_ARTIFACT_TRANSFER_MAX_COPIES_V1 &&
      this.#activeTransferBytes + this.#reservedTransferBytes + bytes <=
        EXPORT_ARTIFACT_TRANSFER_MAX_BYTES_V1;
    if (available()) {
      this.#reservedTransferCopies += 1;
      this.#reservedTransferBytes += bytes;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: TransferWaiterV1 = {
        bytes,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#transferWaiters.indexOf(waiter);
          if (index >= 0) this.#transferWaiters.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.#transferWaiters.push(waiter);
    });
  }

  #drainTransfers(): void {
    if (this.#disposed) return;
    for (let index = 0; index < this.#transferWaiters.length; ) {
      const waiter = this.#transferWaiters[index]!;
      if (waiter.signal.aborted) {
        this.#transferWaiters.splice(index, 1);
        continue;
      }
      if (
        this.#copies.size >= EXPORT_ARTIFACT_TRANSFER_MAX_COPIES_V1 ||
        this.#copies.size + this.#reservedTransferCopies >=
          EXPORT_ARTIFACT_TRANSFER_MAX_COPIES_V1 ||
        this.#activeTransferBytes + this.#reservedTransferBytes + waiter.bytes >
          EXPORT_ARTIFACT_TRANSFER_MAX_BYTES_V1
      ) {
        index += 1;
        continue;
      }
      this.#transferWaiters.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.abort);
      this.#reservedTransferCopies += 1;
      this.#reservedTransferBytes += waiter.bytes;
      waiter.resolve();
    }
  }

  loadPort(artifact: ArtifactReferenceV1): ArtifactLoadPortV1 {
    const entry = [...this.#entries.values()].find(
      (candidate) =>
        candidate.resource.usage.artifactId === artifact.artifactId &&
        candidate.resource.usage.versionId === artifact.versionId,
    );
    if (entry === undefined) throw new TypeError('artifact package is unavailable');
    return {
      readMetadata: async ({ signal }) => {
        const certified = await waitForSignal(this.#certify(entry), signal);
        return { manifest: certified.decoded.manifest, runtime: runtime(artifact) };
      },
      readPackage: async ({ signal }) => {
        const certified = await waitForSignal(this.#certify(entry), signal);
        await this.#acquireTransfer(certified.bytes.byteLength, signal);
        if (this.#disposed || signal.aborted) {
          this.#reservedTransferCopies -= 1;
          this.#reservedTransferBytes -= certified.bytes.byteLength;
          this.#drainTransfers();
          throw new DOMException('Aborted', 'AbortError');
        }
        let copy: Uint8Array;
        try {
          copy = certified.bytes.slice();
        } catch (error) {
          this.#reservedTransferCopies -= 1;
          this.#reservedTransferBytes -= certified.bytes.byteLength;
          this.#drainTransfers();
          throw error;
        }
        this.#reservedTransferCopies -= 1;
        this.#reservedTransferBytes -= certified.bytes.byteLength;
        this.#copies.set(copy, copy.byteLength);
        this.#activeTransferBytes += copy.byteLength;
        this.#peakTransferBytes = Math.max(this.#peakTransferBytes, this.#activeTransferBytes);
        this.#peakTransferCopies = Math.max(this.#peakTransferCopies, this.#copies.size);
        return copy;
      },
      releasePackage: (bytes) => this.releasePackage(bytes),
    };
  }

  releasePackage(bytes: Uint8Array): void {
    const ownedBytes = this.#copies.get(bytes);
    if (ownedBytes === undefined) return;
    bytes.fill(0);
    this.#copies.delete(bytes);
    this.#activeTransferBytes -= ownedBytes;
    this.#drainTransfers();
  }

  inspectTransfersV1(): Readonly<{
    activeCopies: number;
    activeBytes: number;
    peakCopies: number;
    peakBytes: number;
    waiting: number;
  }> {
    return Object.freeze({
      activeCopies: this.#copies.size,
      activeBytes: this.#activeTransferBytes,
      peakCopies: this.#peakTransferCopies,
      peakBytes: this.#peakTransferBytes,
      waiting: this.#transferWaiters.length,
    });
  }

  resolveArtifactImage(
    input: Extract<Parameters<MediaResolverV1>[0], { artifact: ArtifactReferenceV1 }>,
  ): ReturnType<MediaResolverV1> {
    const entry = [...this.#entries.values()].find(
      (candidate) =>
        candidate.resource.usage.artifactId === input.artifact.artifactId &&
        candidate.resource.usage.versionId === input.artifact.versionId,
    );
    if (entry === undefined)
      return {
        error: 'unavailable',
        [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'artifact', sha256: input.sha256 },
      };
    if (entry.certified === null) return { error: 'pending' };
    const resource = entry.certified.decoded.resources.find(
      (candidate) => candidate.path === input.path && candidate.sha256 === input.sha256,
    );
    if (
      resource === undefined ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(resource.mediaType) ||
      resource.byteLength !== resource.bytes.byteLength
    )
      return {
        error: 'unavailable',
        [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'artifact', sha256: input.sha256 },
      };
    const key = `${entry.resource.sha256}\0${resource.path}\0${resource.sha256}`;
    let url = this.#dataUrls.get(key);
    if (url === undefined) {
      url = `data:${resource.mediaType};base64,${base64(resource.bytes)}`;
      this.#dataUrls.set(key, url);
    }
    return {
      url,
      [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'artifact', sha256: resource.sha256 },
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller.abort();
    for (const waiter of this.#transferWaiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(new TypeError('artifact package store is disposed'));
    }
    for (const bytes of this.#copies.keys()) bytes.fill(0);
    this.#copies.clear();
    this.#activeTransferBytes = 0;
    this.#dataUrls.clear();
    for (const entry of this.#entries.values()) {
      entry.certified?.bytes.fill(0);
      entry.certified = null;
      entry.promise = null;
    }
    this.#entries.clear();
  }
}

export function ExportArtifactHost({
  projection,
  packageStore,
  runtimeOrigin,
  node,
  context: _context,
}: {
  projection: ExportProjectionV1;
  packageStore: ExportArtifactPackageStoreV1;
  runtimeOrigin: string;
  node: Parameters<RendererComponentV1<'content.artifact'>>[0]['node'];
  context: Parameters<RendererComponentV1<'content.artifact'>>[0]['context'];
}) {
  const resource = projection.resources.find(
    (candidate) =>
      candidate.usage.kind === 'artifact' &&
      candidate.usage.artifactId === node.artifact.artifactId &&
      candidate.usage.versionId === node.artifact.versionId,
  );
  if (resource === undefined)
    return <section data-export-unsupported="artifact">Required artifact is unavailable.</section>;
  const load = packageStore.loadPort(node.artifact);
  return (
    <ArtifactHost
      boardId={projection.boardId}
      artifact={node.artifact}
      runtime={runtime(node.artifact)}
      runtimeOrigin={runtimeOrigin}
      routeEpoch={projection.revisionId}
      snapshotWatermark={projection.revisionNumber}
      load={load}
      hostInstanceId={node.id}
      incarnationKey={`${projection.revisionId}:${node.id}:${node.artifact.artifactId}:${node.artifact.versionId}`}
      viewMode="fit-page"
      showStopControl={false}
      onViewStateChange={() => undefined}
      onCaptureActiveChange={() => undefined}
    />
  );
}
