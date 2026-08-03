import { createHash, timingSafeEqual } from 'node:crypto';

import {
  adaptLegacySceneToDocumentV2,
  collectArtifactReferencesAcrossSnapshotV2,
  collectDocumentNodesV2,
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  presentationFormatDescriptorV1,
  projectDocumentV2ToV3,
  type ArtifactReferenceV1,
  type BoardDocumentV3,
  type BoardId,
  type PresentationFormatDescriptorV1,
  type RevisionId,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { ArtifactRepository } from '../artifacts/artifact.repository.js';
import { encodeArtifactPackageV1 } from '../artifacts/artifact-package.builder.js';
import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import {
  decodeMediaIdFromStorage,
  decodePageIdFromStorage,
  type RevisionMediaReferenceRowV1,
} from '../media/media-reference.types.js';
import { RevisionMediaReferenceExtractor } from '../media/revision-media-reference.extractor.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import {
  extractDocumentArtifactReferences,
  type SceneArtifactReferenceRowV1,
} from '../revisions/scene-artifact-reference.extractor.js';
import { ExportFailureV1 } from './export-errors.js';
import {
  EXPORT_ARTIFACT_PAGE_RESIDENT_MAX_BYTES_V1,
  EXPORT_MAX_PAGES_V1,
  EXPORT_PROJECTION_MAX_BYTES_V1,
  EXPORT_RESOURCE_MAX_BYTES_V1,
  EXPORT_RESOURCE_MAX_COUNT_V1,
  EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1,
} from './export-request.schema.js';
import {
  ExportRevisionHoldRepositoryV1,
  type ExportRevisionHoldV1,
} from './export-revision-hold.repository.js';

export const EXPORT_PROJECTION_MEDIA_TYPE_V1 = 'application/vnd.sceneboard.export-projection+json';
export const EXPORT_ARTIFACT_PACKAGE_MEDIA_TYPE_V1 =
  'application/vnd.sceneboard.artifact-package+zip';

export type ExportResourceMediaTypeV1 =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'font/woff2'
  | typeof EXPORT_ARTIFACT_PACKAGE_MEDIA_TYPE_V1;

export type ExportProjectionResourceV1 = Readonly<{
  sha256: string;
  mediaType: ExportResourceMediaTypeV1;
  byteLength: number;
  url: string;
  usage:
    | Readonly<{ kind: 'media'; mediaId: string }>
    | Readonly<{ kind: 'artifact'; artifactId: string; versionId: string }>
    | Readonly<{ kind: 'font'; family: 'Noto Sans KR'; subset: 'korean' | 'latin' }>;
}>;

export type ImmutableExportProjectionV1 = Readonly<{
  schemaVersion: 1;
  boardId: BoardId;
  revisionId: RevisionId;
  revisionNumber: number;
  document: BoardDocumentV3;
  format: PresentationFormatDescriptorV1;
  resources: readonly ExportProjectionResourceV1[];
}>;

export type ExportProjectionBundleV1 = Readonly<{
  projection: ImmutableExportProjectionV1;
  projectionBytes: Buffer;
  projectionSha256: string;
  resourceBytes: ReadonlyMap<string, Buffer>;
  hold: ExportRevisionHoldV1;
}>;

export type ExportFontResourceV1 = Readonly<{
  sha256: string;
  bytes: Buffer;
  subset: 'korean' | 'latin';
}>;

interface RevisionProjectionRow extends RowDataPacket {
  revisionPk: string;
  revisionId: Buffer;
  revisionNumber: string;
  schemaVersion: string;
  codec: string;
  payload: Buffer;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
}

interface MediaInventoryProjectionRow extends RowDataPacket {
  mediaId: Buffer;
  ordinal: number;
  mediaType: ExportResourceMediaTypeV1;
  byteLength: number;
  sha256: Buffer;
}

interface MediaProjectionRow extends MediaInventoryProjectionRow {
  bytes: Buffer;
}

interface MediaReferenceProjectionRow extends RowDataPacket {
  mediaId: Buffer;
  firstPageId: Buffer;
  ordinal: number;
}

interface ArtifactReferenceProjectionRow extends RowDataPacket {
  artifactId: string;
  artifactVersionId: string;
  referenceCode: string;
  occurrenceCount: number;
}

export const canonicalizeExportProjectionV1 = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeExportProjectionV1).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeExportProjectionV1(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`;
};

const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

type ExportResourceCollectionV1 = {
  descriptors: Map<string, ExportProjectionResourceV1>;
  bytes: Map<string, { mediaType: ExportResourceMediaTypeV1; bytes: Buffer }>;
};

const freezeJsonValue = (value: unknown): void => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJsonValue(child);
  Object.freeze(value);
};

class RuntimeImmutableResourceBytesV1 {
  readonly #resources = new Map<
    string,
    Readonly<{ mediaType: ExportResourceMediaTypeV1; byteLength: number; bytes: Buffer }>
  >();

  constructor(
    resources: ReadonlyMap<
      string,
      Readonly<{ mediaType: ExportResourceMediaTypeV1; bytes: Buffer }>
    >,
    descriptors: readonly ExportProjectionResourceV1[],
  ) {
    const expected = new Map<
      string,
      Readonly<{ mediaType: ExportResourceMediaTypeV1; byteLength: number }>
    >();
    for (const descriptor of descriptors) {
      const existing = expected.get(descriptor.sha256);
      if (
        existing !== undefined &&
        (existing.mediaType !== descriptor.mediaType || existing.byteLength !== descriptor.byteLength)
      )
        throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
      expected.set(descriptor.sha256, {
        mediaType: descriptor.mediaType,
        byteLength: descriptor.byteLength,
      });
    }
    for (const [digest, resource] of resources) {
      const descriptor = expected.get(digest);
      if (
        descriptor === undefined ||
        descriptor.mediaType !== resource.mediaType ||
        descriptor.byteLength !== resource.bytes.byteLength ||
        sha256(resource.bytes).toString('hex') !== digest
      )
        throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
      this.#resources.set(
        digest,
        Object.freeze({
          mediaType: resource.mediaType,
          byteLength: descriptor.byteLength,
          bytes: Buffer.from(resource.bytes),
        }),
      );
    }
    if (this.#resources.size !== expected.size)
      throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
    Object.freeze(this);
  }

  get size(): number {
    return this.#resources.size;
  }

  get(digest: string): Buffer | undefined {
    const resource = this.#resources.get(digest);
    if (resource === undefined) return undefined;
    if (
      resource.bytes.byteLength !== resource.byteLength ||
      sha256(resource.bytes).toString('hex') !== digest
    )
      throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
    return Buffer.from(resource.bytes);
  }

  has(digest: string): boolean {
    return this.#resources.has(digest);
  }

  keys(): IterableIterator<string> {
    return this.#resources.keys();
  }

  *values(): IterableIterator<Buffer> {
    for (const digest of this.#resources.keys()) {
      const bytes = this.get(digest);
      if (bytes !== undefined) yield bytes;
    }
  }

  *entries(): IterableIterator<[string, Buffer]> {
    for (const digest of this.#resources.keys()) {
      const bytes = this.get(digest);
      if (bytes !== undefined) yield [digest, bytes];
    }
  }

  [Symbol.iterator](): IterableIterator<[string, Buffer]> {
    return this.entries();
  }

  forEach(
    callback: (value: Buffer, key: string, map: ReadonlyMap<string, Buffer>) => void,
    thisArg?: unknown,
  ): void {
    for (const [digest, bytes] of this.entries())
      callback.call(
        thisArg,
        bytes,
        digest,
        this as unknown as ReadonlyMap<string, Buffer>,
      );
  }
}

const usageKey = (usage: ExportProjectionResourceV1['usage']): string =>
  usage.kind === 'media'
    ? `media:${usage.mediaId}`
    : usage.kind === 'artifact'
      ? `artifact:${usage.artifactId}:${usage.versionId}`
      : `font:${usage.subset}`;

export const assertExportArtifactPageResidentMemoryV1 = (
  document: BoardDocumentV3,
  resources: Iterable<ExportProjectionResourceV1>,
): void => {
  const packageBytes = new Map<string, number>();
  for (const resource of resources) {
    if (resource.usage.kind !== 'artifact') continue;
    packageBytes.set(
      `${resource.usage.artifactId}\0${resource.usage.versionId}`,
      resource.byteLength,
    );
  }
  const pageBytes = new Map<string, number>();
  for (const item of collectDocumentNodesV2(document)) {
    if (item.node.type !== 'content.artifact') continue;
    const bytes = packageBytes.get(
      `${item.node.artifact.artifactId}\0${item.node.artifact.versionId}`,
    );
    if (bytes === undefined) throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    const total = (pageBytes.get(item.page.pageId) ?? 0) + bytes;
    if (!Number.isSafeInteger(total) || total > EXPORT_ARTIFACT_PAGE_RESIDENT_MAX_BYTES_V1)
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    pageBytes.set(item.page.pageId, total);
  }
};

const revisionNumber = (value: string): number => {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
  return parsed;
};

const databasePk = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
  return parsed;
};

export class ExportProjectionServiceV1 {
  constructor(
    private readonly checkpoints: DocumentCheckpointCodec,
    private readonly artifacts: ArtifactRepository,
    private readonly holds: ExportRevisionHoldRepositoryV1,
    private readonly fonts: readonly ExportFontResourceV1[],
    private readonly mediaReferences = new RevisionMediaReferenceExtractor(),
  ) {}

  async project(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      boardId: BoardId;
      revisionId: RevisionId | null;
      sessionId: string;
      holdOwnerId: string;
    },
  ): Promise<ExportProjectionBundleV1> {
    const revision = await this.lockRevision(connection, input);
    const hold = await this.holds.acquire(connection, {
      boardPk: input.boardPk,
      revisionPk: databasePk(revision.revisionPk),
      holderId: input.holdOwnerId,
    });
    try {
      const decoded = await this.checkpoints.decode({
        schemaVersion: revision.schemaVersion,
        codec: revision.codec,
        payload: revision.payload,
        canonicalBytes: revision.canonicalBytes,
        storedBytes: revision.storedBytes,
        sha256: revision.sha256,
      });
      const document =
        decoded.kind === 'scene'
          ? projectDocumentV2ToV3(
              adaptLegacySceneToDocumentV2({
                boardId: input.boardId,
                scene: decoded.scene,
              }),
            )
          : decoded.document.schemaVersion === 3
            ? decoded.document
            : projectDocumentV2ToV3(decoded.document);
      if (document.pages.length > EXPORT_MAX_PAGES_V1)
        throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
      const revisionPk = databasePk(revision.revisionPk);
      const revisionId = formatPublicUuidV4(revision.revisionId) as RevisionId;
      const resources: ExportResourceCollectionV1 = {
        descriptors: new Map(),
        bytes: new Map(),
      };
      await this.addMediaResources(
        connection,
        revisionPk,
        input.boardId,
        document,
        revisionId,
        input.sessionId,
        resources,
      );
      await this.addArtifactResources(
        connection,
        revisionPk,
        input.boardId,
        document,
        revisionId,
        input.sessionId,
        resources,
      );
      assertExportArtifactPageResidentMemoryV1(document, resources.descriptors.values());
      for (const font of this.fonts)
        this.addResource(
          resources,
          input.sessionId,
          'font/woff2',
          font.bytes,
          { kind: 'font', family: 'Noto Sans KR', subset: font.subset },
          font.sha256,
        );
      const projection: ImmutableExportProjectionV1 = Object.freeze({
        schemaVersion: 1,
        boardId: input.boardId,
        revisionId,
        revisionNumber: revisionNumber(revision.revisionNumber),
        document,
        format: presentationFormatDescriptorV1(document.format),
        resources: Object.freeze(
          [...resources.descriptors.values()].sort(
            (left, right) =>
              left.sha256.localeCompare(right.sha256) ||
              usageKey(left.usage).localeCompare(usageKey(right.usage)),
          ),
        ),
      });
      return this.sealBundle(projection, resources, hold);
    } catch (error) {
      await this.holds.release(connection, hold).catch(() => undefined);
      throw error;
    }
  }

  private sealBundle(
    projection: ImmutableExportProjectionV1,
    resources: ExportResourceCollectionV1,
    hold: ExportRevisionHoldV1,
  ): ExportProjectionBundleV1 {
    const canonicalProjectionBytes = Buffer.from(
      canonicalizeExportProjectionV1(projection),
      'utf8',
    );
    if (canonicalProjectionBytes.byteLength > EXPORT_PROJECTION_MAX_BYTES_V1)
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    const projectionSha256 = sha256(canonicalProjectionBytes).toString('hex');
    const immutableProjection = JSON.parse(
      canonicalProjectionBytes.toString('utf8'),
    ) as ImmutableExportProjectionV1;
    freezeJsonValue(immutableProjection);
    const resourceBytes = new RuntimeImmutableResourceBytesV1(
      resources.bytes,
      immutableProjection.resources,
    ) as unknown as ReadonlyMap<string, Buffer>;
    return Object.freeze({
      projection: immutableProjection,
      get projectionBytes(): Buffer {
        if (sha256(canonicalProjectionBytes).toString('hex') !== projectionSha256)
          throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
        return Buffer.from(canonicalProjectionBytes);
      },
      projectionSha256,
      resourceBytes,
      hold: Object.freeze({ ...hold }),
    });
  }

  private async lockRevision(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      revisionId: RevisionId | null;
    },
  ): Promise<RevisionProjectionRow> {
    const parameters =
      input.revisionId === null
        ? [input.boardPk.toString()]
        : [input.boardPk.toString(), input.revisionId];
    const predicate =
      input.revisionId === null
        ? `r.revision_pk = (
             SELECT h.head_revision_pk FROM board_heads h WHERE h.board_pk = r.board_pk
           )`
        : 'BIN_TO_UUID(r.revision_id) = ?';
    const [rows] = await connection.execute<RevisionProjectionRow[]>(
      `SELECT CAST(r.revision_pk AS CHAR) AS revisionPk, r.revision_id AS revisionId,
              CAST(r.revision_number AS CHAR) AS revisionNumber,
              p.schema_version AS schemaVersion, p.codec, p.payload,
              p.canonical_bytes AS canonicalBytes, p.stored_bytes AS storedBytes,
              p.payload_sha256 AS sha256
       FROM board_revisions r
       JOIN board_revision_catalog c
         ON c.board_pk = r.board_pk AND c.revision_pk = r.revision_pk
       JOIN board_revision_payloads p
         ON p.revision_pk = r.revision_pk AND p.state = 'available'
       WHERE r.board_pk = ? AND ${predicate}
       LIMIT 1 FOR UPDATE`,
      parameters,
    );
    const row = rows[0];
    if (rows.length === 0) throw new ExportFailureV1('EXPORT_NOT_FOUND');
    if (rows.length !== 1 || row === undefined) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
    return row;
  }

  private async addMediaResources(
    connection: PoolConnection,
    revisionPk: bigint,
    boardId: BoardId,
    document: BoardDocumentV3,
    revisionId: RevisionId,
    sessionId: string,
    output: ExportResourceCollectionV1,
  ): Promise<void> {
    const expected = this.mediaReferences.extract({ boardId, revisionId, document });
    const [referenceRows] = await connection.execute<MediaReferenceProjectionRow[]>(
      `SELECT media_id AS mediaId, first_page_id AS firstPageId, ordinal
       FROM board_revision_media_refs
       WHERE revision_pk = ?
       ORDER BY ordinal`,
      [revisionPk.toString()],
    );
    this.assertMediaReferences(referenceRows, expected);
    const [inventory] = await connection.execute<MediaInventoryProjectionRow[]>(
      `SELECT r.media_id AS mediaId, r.ordinal, o.mime AS mediaType,
              o.byte_length AS byteLength, o.sha256
       FROM board_revision_media_refs r
       JOIN board_media m ON m.media_id = r.media_id AND m.board_pk = r.board_pk
       JOIN media_objects o ON o.media_pk = m.media_pk
       WHERE r.revision_pk = ? AND m.status = 'active' AND o.state = 'active'
       ORDER BY r.ordinal`,
      [revisionPk.toString()],
    );
    if (inventory.length !== expected.length)
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    if (inventory.length > EXPORT_RESOURCE_MAX_COUNT_V1)
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    const uniqueBytes = new Map<
      string,
      Readonly<{ mediaType: ExportResourceMediaTypeV1; byteLength: number }>
    >();
    let totalBytes = 0;
    for (let index = 0; index < inventory.length; index += 1) {
      const row = inventory[index];
      const reference = expected[index];
      if (
        row === undefined ||
        reference === undefined ||
        !Buffer.isBuffer(row.mediaId) ||
        !Number.isSafeInteger(row.ordinal) ||
        row.ordinal !== reference.ordinal ||
        this.decodeMediaId(row.mediaId) !== reference.mediaId ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(row.mediaType) ||
        !Number.isSafeInteger(row.byteLength) ||
        row.byteLength < 1 ||
        !Buffer.isBuffer(row.sha256) ||
        row.sha256.byteLength !== 32
      )
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
      if (row.byteLength > EXPORT_RESOURCE_MAX_BYTES_V1)
        throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
      const digest = row.sha256.toString('hex');
      const existing = uniqueBytes.get(digest);
      if (
        existing !== undefined &&
        (existing.mediaType !== row.mediaType || existing.byteLength !== row.byteLength)
      )
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
      if (existing === undefined) {
        totalBytes += row.byteLength;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1)
          throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
        uniqueBytes.set(digest, { mediaType: row.mediaType, byteLength: row.byteLength });
      }
    }
    if (inventory.length === 0) return;
    const [rows] = await connection.execute<MediaProjectionRow[]>(
      `SELECT r.media_id AS mediaId, r.ordinal, o.mime AS mediaType, o.bytes,
              o.byte_length AS byteLength, o.sha256
       FROM board_revision_media_refs r
       JOIN board_media m ON m.media_id = r.media_id AND m.board_pk = r.board_pk
       JOIN media_objects o ON o.media_pk = m.media_pk
       WHERE r.revision_pk = ? AND m.status = 'active' AND o.state = 'active'
       ORDER BY r.ordinal`,
      [revisionPk.toString()],
    );
    if (rows.length !== inventory.length)
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const certified = inventory[index];
      const reference = expected[index];
      if (
        row === undefined ||
        certified === undefined ||
        reference === undefined ||
        !Buffer.isBuffer(row.mediaId) ||
        !row.mediaId.equals(certified.mediaId) ||
        row.ordinal !== certified.ordinal ||
        row.mediaType !== certified.mediaType ||
        !Number.isSafeInteger(row.byteLength) ||
        row.byteLength !== certified.byteLength ||
        !Buffer.isBuffer(row.sha256) ||
        row.sha256.byteLength !== 32 ||
        !timingSafeEqual(row.sha256, certified.sha256) ||
        !Buffer.isBuffer(row.bytes) ||
        row.bytes.byteLength !== certified.byteLength ||
        !timingSafeEqual(sha256(row.bytes), certified.sha256)
      )
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
      this.addResource(
        output,
        sessionId,
        row.mediaType,
        row.bytes,
        { kind: 'media', mediaId: reference.mediaId },
        certified.sha256.toString('hex'),
      );
    }
  }

  private async addArtifactResources(
    connection: PoolConnection,
    revisionPk: bigint,
    boardId: BoardId,
    document: BoardDocumentV3,
    revisionId: RevisionId,
    sessionId: string,
    output: ExportResourceCollectionV1,
  ): Promise<void> {
    const expectedReferences = extractDocumentArtifactReferences(document);
    await this.assertArtifactReferences(connection, revisionPk, expectedReferences);
    const inventory = new Map<string, { artifact: ArtifactReferenceV1 }>();
    for (const item of collectDocumentNodesV2(document)) {
      const artifact =
        item.node.type === 'content.artifact'
          ? item.node.artifact
          : item.node.type === 'content.image' && item.node.source.type === 'artifact.resource'
            ? item.node.source.artifact
            : null;
      if (artifact === null) continue;
      const key = `${artifact.artifactId}\0${artifact.versionId}`;
      if (!inventory.has(key)) inventory.set(key, { artifact });
    }
    const references = collectArtifactReferencesAcrossSnapshotV2({
      boardId,
      revisionId,
      snapshot: {
        boardId,
        revision: { revisionId },
        document,
        artifacts: [...inventory.values()],
      },
    });
    for (const reference of references) {
      let bytes: Buffer;
      try {
        const artifact = await this.artifacts.readImmutablePackage(connection, boardId, reference);
        bytes = encodeArtifactPackageV1(artifact.manifestBytes, artifact.resources);
      } catch (error) {
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED', error);
      }
      this.addResource(output, sessionId, EXPORT_ARTIFACT_PACKAGE_MEDIA_TYPE_V1, bytes, {
        kind: 'artifact',
        artifactId: reference.artifactId,
        versionId: reference.versionId,
      });
    }
  }

  private async assertArtifactReferences(
    connection: PoolConnection,
    revisionPk: bigint,
    expected: readonly SceneArtifactReferenceRowV1[],
  ): Promise<void> {
    const [rows] = await connection.execute<ArtifactReferenceProjectionRow[]>(
      `SELECT artifact_id AS artifactId, artifact_version_id AS artifactVersionId,
              reference_code AS referenceCode, occurrence_count AS occurrenceCount
       FROM board_revision_artifact_refs
       WHERE revision_pk = ?
       ORDER BY artifact_id, artifact_version_id, reference_code`,
      [revisionPk.toString()],
    );
    if (rows.length !== expected.length)
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const reference = expected[index];
      if (
        row === undefined ||
        reference === undefined ||
        typeof row.artifactId !== 'string' ||
        typeof row.artifactVersionId !== 'string' ||
        (row.referenceCode !== 'A' && row.referenceCode !== 'I') ||
        !Number.isSafeInteger(row.occurrenceCount) ||
        row.occurrenceCount < 1 ||
        row.occurrenceCount > MAX_ARTIFACT_REFERENCE_OCCURRENCES ||
        row.artifactId !== reference.artifactId ||
        row.artifactVersionId !== reference.artifactVersionId ||
        row.referenceCode !== reference.referenceCode ||
        row.occurrenceCount !== reference.occurrenceCount
      )
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    }
  }

  private assertMediaReferences(
    rows: readonly MediaReferenceProjectionRow[],
    expected: readonly RevisionMediaReferenceRowV1[],
  ): void {
    if (rows.length !== expected.length)
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const reference = expected[index];
      if (
        row === undefined ||
        reference === undefined ||
        !Buffer.isBuffer(row.mediaId) ||
        !Buffer.isBuffer(row.firstPageId) ||
        !Number.isSafeInteger(row.ordinal) ||
        row.ordinal !== reference.ordinal ||
        this.decodeMediaId(row.mediaId) !== reference.mediaId ||
        this.decodePageId(row.firstPageId) !== reference.firstPageId
      )
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    }
  }

  private decodeMediaId(value: Buffer): RevisionMediaReferenceRowV1['mediaId'] {
    try {
      return decodeMediaIdFromStorage(value);
    } catch (error) {
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED', error);
    }
  }

  private decodePageId(value: Buffer): RevisionMediaReferenceRowV1['firstPageId'] {
    try {
      return decodePageIdFromStorage(value);
    } catch (error) {
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED', error);
    }
  }

  private addResource(
    output: ExportResourceCollectionV1,
    sessionId: string,
    mediaType: ExportResourceMediaTypeV1,
    bytes: Buffer,
    usage: ExportProjectionResourceV1['usage'],
    assertedDigest?: string,
  ): void {
    const digest = sha256(bytes).toString('hex');
    if (assertedDigest !== undefined && assertedDigest !== digest)
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    if (bytes.byteLength > EXPORT_RESOURCE_MAX_BYTES_V1)
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    const key = usageKey(usage);
    const existingDescriptor = output.descriptors.get(key);
    if (existingDescriptor !== undefined) {
      if (existingDescriptor.sha256 !== digest || existingDescriptor.mediaType !== mediaType)
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
      return;
    }
    const existingBytes = output.bytes.get(digest);
    if (existingBytes !== undefined && existingBytes.mediaType !== mediaType)
      throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
    const totalBytes =
      [...output.bytes.values()].reduce((total, resource) => total + resource.bytes.byteLength, 0) +
      (existingBytes === undefined ? bytes.byteLength : 0);
    if (
      output.descriptors.size + 1 > EXPORT_RESOURCE_MAX_COUNT_V1 ||
      totalBytes > EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1
    )
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    output.descriptors.set(
      key,
      Object.freeze({
        sha256: digest,
        mediaType,
        byteLength: bytes.byteLength,
        url: `/internal/v1/export-render/${sessionId}/resources/${digest}`,
        usage,
      }),
    );
    if (existingBytes === undefined)
      output.bytes.set(digest, { mediaType, bytes: Buffer.from(bytes) });
  }
}
