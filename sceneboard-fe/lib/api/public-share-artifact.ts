import {
  decodeArtifactPackageV1,
  type DecodedArtifactPackageV1,
} from '@sceneboard/artifact-runtime/package';
import {
  BOARD_LIMITS_V1,
  PublicShareStateParserV1,
  type ArtifactReferenceV1,
  type ArtifactRuntimeSummaryV1,
  type BoardId,
  type PublicArtifactSummaryV1,
  type PublicShareStateV1,
  type TimestampV1,
} from '@sceneboard/board-schema';
import { BoardSdkHttpClient } from '@sceneboard/board-sdk/http';
import type { ArtifactLoadPortV1 } from '@sceneboard/board-ui/artifact';

type ReadyPublicShareV1 = Extract<PublicShareStateV1, { state: 'ready' }>;
type ReadyPublicArtifactV1 = Extract<PublicArtifactSummaryV1, { status: 'ready' }>;

type CertifiedPublicArtifactV1 = Readonly<{
  bytes: Uint8Array;
  decoded: DecodedArtifactPackageV1;
}>;

type PublicArtifactProjectionIdentityV1 = Readonly<{
  shareId: string;
  boardId: BoardId;
  revisionId: string;
  publicationGeneration: number;
  accessGeneration: number;
}>;

type SlotWaiterV1 = {
  signal: AbortSignal;
  resolve(): void;
  reject(error: Error): void;
  abort(): void;
};

export type PublicArtifactLoadHandleV1 = Readonly<{
  load: ArtifactLoadPortV1;
  dispose(): void;
}>;

export const PUBLIC_ARTIFACT_ACTIVE_HANDSHAKES_MAX_V1 = 2;
export const PUBLIC_ARTIFACT_PACKAGE_MAX_BYTES_V1 = BOARD_LIMITS_V1.maxArtifactTotalBytes + 262_144;

const PUBLIC_ARTIFACT_CONTENT_TYPE_V1 = 'application/vnd.leecat.artifact-package.v1';

const canonicalOriginV1 = (value: string): string => {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  )
    throw new TypeError('public artifact API origin is invalid');
  return parsed.origin;
};

const artifactKeyV1 = (artifact: ArtifactReferenceV1): string =>
  `${artifact.artifactId}\u0000${artifact.versionId}`;

const projectionIdentityV1 = (
  accepted: ReadyPublicShareV1,
): PublicArtifactProjectionIdentityV1 => ({
  shareId: accepted.projection.shareId,
  boardId: accepted.projection.boardId,
  revisionId: accepted.projection.revisionId,
  publicationGeneration: accepted.projection.publicationGeneration,
  accessGeneration: accepted.projection.accessGeneration,
});

const sameProjectionIdentityV1 = (
  left: PublicArtifactProjectionIdentityV1,
  right: PublicArtifactProjectionIdentityV1,
): boolean =>
  left.shareId === right.shareId &&
  left.boardId === right.boardId &&
  left.revisionId === right.revisionId &&
  left.publicationGeneration === right.publicationGeneration &&
  left.accessGeneration === right.accessGeneration;

const readyArtifactsV1 = (
  accepted: ReadyPublicShareV1,
): Readonly<{
  entries: Map<string, ReadyPublicArtifactV1>;
  packageUrls: Set<string>;
}> => {
  const entries = new Map<string, ReadyPublicArtifactV1>();
  const packageUrls = new Set<string>();
  for (const summary of accepted.projection.artifacts) {
    if (summary.status !== 'ready') continue;
    entries.set(`${summary.artifactId}\u0000${summary.versionId}`, summary);
    packageUrls.add(summary.packageUrl);
  }
  return { entries, packageUrls };
};

const runtimeV1 = (artifact: ArtifactReferenceV1): ArtifactRuntimeSummaryV1 => ({
  artifact,
  status: 'ready',
  updatedAt: '1970-01-01T00:00:00.000Z' as TimestampV1,
  failure: null,
});

const hasPrivateNoStoreV1 = (value: string | null): boolean => {
  if (value === null) return false;
  const directives = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return (
    directives.length === 2 &&
    new Set(directives).size === 2 &&
    directives.includes('private') &&
    directives.includes('no-store')
  );
};

const contentLengthV1 = (value: string | null): number | null => {
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value))
    throw new TypeError('public artifact content length is invalid');
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > PUBLIC_ARTIFACT_PACKAGE_MAX_BYTES_V1)
    throw new TypeError('public artifact content length is invalid');
  return length;
};

class PublicArtifactLoadHandle implements PublicArtifactLoadHandleV1 {
  readonly load: ArtifactLoadPortV1;
  readonly #store: PublicArtifactPackageStoreV1;
  readonly #artifact: ArtifactReferenceV1;
  readonly #controller = new AbortController();
  #certified: CertifiedPublicArtifactV1 | null = null;
  #promise: Promise<CertifiedPublicArtifactV1> | null = null;
  #boundSignal: AbortSignal | null = null;
  #boundAbort: (() => void) | null = null;
  #holdsSlot = false;
  #disposed = false;

  constructor(store: PublicArtifactPackageStoreV1, artifact: ArtifactReferenceV1) {
    this.#store = store;
    this.#artifact = artifact;
    this.load = {
      readMetadata: async (input) => {
        this.#assertInput(input.boardId, input.artifact);
        const certified = await this.#ensure(input.signal);
        return { manifest: certified.decoded.manifest, runtime: runtimeV1(this.#artifact) };
      },
      readPackage: async (input) => {
        this.#assertInput(input.boardId, input.artifact);
        return (await this.#ensure(input.signal)).bytes;
      },
      releasePackage: (bytes) => {
        if (bytes === this.#certified?.bytes) this.dispose();
      },
    };
  }

  #assertInput(boardId: BoardId, artifact: ArtifactReferenceV1): void {
    if (
      this.#disposed ||
      boardId !== this.#store.boardId ||
      artifact.artifactId !== this.#artifact.artifactId ||
      artifact.versionId !== this.#artifact.versionId
    )
      throw new TypeError('public artifact loader identity mismatch');
  }

  #bindSignal(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.#boundSignal === signal) return;
    if (this.#boundSignal !== null)
      throw new TypeError('public artifact loader signal changed during a handshake');
    const abort = () => this.dispose();
    signal.addEventListener('abort', abort, { once: true });
    this.#boundSignal = signal;
    this.#boundAbort = abort;
  }

  async #ensure(signal: AbortSignal): Promise<CertifiedPublicArtifactV1> {
    this.#bindSignal(signal);
    if (this.#disposed) throw new TypeError('public artifact loader is disposed');
    if (this.#certified !== null) return this.#certified;
    this.#promise ??= this.#load().catch((error: unknown) => {
      this.#promise = null;
      this.dispose();
      throw error;
    });
    return this.#promise;
  }

  async #load(): Promise<CertifiedPublicArtifactV1> {
    await this.#store.acquire(this.#controller.signal);
    if (this.#disposed || this.#controller.signal.aborted) {
      this.#store.release();
      throw new DOMException('Aborted', 'AbortError');
    }
    this.#holdsSlot = true;
    let bytes: Uint8Array | null = null;
    try {
      const response = await this.#store.fetchArtifactPackage(
        this.#artifact,
        this.#controller.signal,
      );
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
          PUBLIC_ARTIFACT_CONTENT_TYPE_V1 ||
        !hasPrivateNoStoreV1(response.headers.get('cache-control'))
      )
        throw new TypeError('public artifact response is invalid');
      const declaredLength = contentLengthV1(response.headers.get('content-length'));
      const body = await BoardSdkHttpClient.readBoundedResponseBodyV1(
        response,
        PUBLIC_ARTIFACT_PACKAGE_MAX_BYTES_V1,
        this.#controller.signal,
      );
      if (typeof body === 'string') throw new TypeError('public artifact body is invalid');
      bytes = body;
      if (declaredLength !== null && declaredLength !== bytes.byteLength)
        throw new TypeError('public artifact content length does not match the body');
      const decoded = await decodeArtifactPackageV1(bytes);
      if (
        decoded.manifest.artifact.artifactId !== this.#artifact.artifactId ||
        decoded.manifest.artifact.versionId !== this.#artifact.versionId ||
        this.#disposed ||
        this.#controller.signal.aborted
      )
        throw new TypeError('public artifact package identity mismatch');
      const certified = Object.freeze({ bytes, decoded });
      this.#certified = certified;
      return certified;
    } catch (error) {
      bytes?.fill(0);
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller.abort();
    if (this.#boundSignal !== null && this.#boundAbort !== null)
      this.#boundSignal.removeEventListener('abort', this.#boundAbort);
    this.#boundSignal = null;
    this.#boundAbort = null;
    this.#certified?.bytes.fill(0);
    this.#certified = null;
    this.#promise = null;
    if (this.#holdsSlot) {
      this.#holdsSlot = false;
      this.#store.release();
    }
    this.#store.close(this);
  }
}

export class PublicArtifactPackageStoreV1 {
  readonly boardId: BoardId;
  readonly #projectionIdentity: PublicArtifactProjectionIdentityV1;
  readonly #apiOrigin: string;
  readonly #fetcher: typeof fetch;
  readonly #entries = new Map<string, ReadyPublicArtifactV1>();
  readonly #packageUrls = new Set<string>();
  readonly #handles = new Set<PublicArtifactLoadHandle>();
  readonly #waiters: SlotWaiterV1[] = [];
  #active = 0;
  #peak = 0;
  #disposed = false;

  constructor(
    accepted: ReadyPublicShareV1,
    options: Readonly<{ apiOrigin: string; fetcher?: typeof fetch }>,
  ) {
    const parsed = PublicShareStateParserV1.parse(accepted);
    if (!parsed.ok || parsed.data.value.state !== 'ready')
      throw new TypeError('public artifact projection is invalid');
    const acceptedReady = parsed.data.value;
    this.boardId = acceptedReady.projection.boardId;
    this.#projectionIdentity = projectionIdentityV1(acceptedReady);
    this.#apiOrigin = canonicalOriginV1(options.apiOrigin);
    this.#fetcher = (options.fetcher ?? fetch).bind(globalThis);
    const current = readyArtifactsV1(acceptedReady);
    for (const [key, summary] of current.entries) this.#entries.set(key, summary);
    for (const packageUrl of current.packageUrls) this.#packageUrls.add(packageUrl);
  }

  renew(accepted: ReadyPublicShareV1): void {
    if (this.#disposed) throw new TypeError('public artifact package store is disposed');
    const parsed = PublicShareStateParserV1.parse(accepted);
    if (
      !parsed.ok ||
      parsed.data.value.state !== 'ready' ||
      !sameProjectionIdentityV1(this.#projectionIdentity, projectionIdentityV1(parsed.data.value))
    )
      throw new TypeError('public artifact projection identity changed');
    const renewed = readyArtifactsV1(parsed.data.value);
    this.#entries.clear();
    this.#packageUrls.clear();
    for (const [key, summary] of renewed.entries) this.#entries.set(key, summary);
    for (const packageUrl of renewed.packageUrls) this.#packageUrls.add(packageUrl);
  }

  open(artifact: ArtifactReferenceV1): PublicArtifactLoadHandleV1 {
    if (this.#disposed) throw new TypeError('public artifact package store is disposed');
    const summary = this.#entries.get(artifactKeyV1(artifact));
    if (summary === undefined) throw new TypeError('public artifact package is unavailable');
    const handle = new PublicArtifactLoadHandle(this, artifact);
    this.#handles.add(handle);
    return handle;
  }

  async acquire(signal: AbortSignal): Promise<void> {
    if (this.#disposed) throw new TypeError('public artifact package store is disposed');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.#active < PUBLIC_ARTIFACT_ACTIVE_HANDSHAKES_MAX_V1) {
      this.#active += 1;
      this.#peak = Math.max(this.#peak, this.#active);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiterV1 = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  release(): void {
    if (this.#active > 0) this.#active -= 1;
    if (this.#disposed) return;
    while (this.#active < PUBLIC_ARTIFACT_ACTIVE_HANDSHAKES_MAX_V1) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) break;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) continue;
      this.#active += 1;
      this.#peak = Math.max(this.#peak, this.#active);
      waiter.resolve();
    }
  }

  close(handle: PublicArtifactLoadHandle): void {
    this.#handles.delete(handle);
  }

  fetchArtifactPackage(artifact: ArtifactReferenceV1, signal: AbortSignal): Promise<Response> {
    if (this.#disposed)
      return Promise.reject(new TypeError('public artifact package store is disposed'));
    const packageUrl = this.#entries.get(artifactKeyV1(artifact))?.packageUrl;
    if (packageUrl === undefined)
      return Promise.reject(new TypeError('public artifact package is unavailable'));
    const url = new URL(packageUrl, this.#apiOrigin);
    if (
      !this.#packageUrls.has(packageUrl) ||
      url.origin !== this.#apiOrigin ||
      `${url.pathname}${url.search}` !== packageUrl
    )
      return Promise.reject(new TypeError('public artifact package URL is invalid'));
    return this.#fetcher(url.href, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  }

  inspectV1(): Readonly<{ active: number; peak: number; waiting: number; handles: number }> {
    return Object.freeze({
      active: this.#active,
      peak: this.#peak,
      waiting: this.#waiters.length,
      handles: this.#handles.size,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(new TypeError('public artifact package store is disposed'));
    }
    for (const handle of [...this.#handles]) handle.dispose();
    this.#entries.clear();
    this.#packageUrls.clear();
    this.#active = 0;
  }
}
