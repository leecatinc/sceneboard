import { createHash, timingSafeEqual } from 'node:crypto';

import {
  adaptLegacySceneToDocumentV2,
  collectArtifactReferencesAcrossSnapshotV2,
  collectDocumentNodesV2,
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
import { decodeMediaIdFromStorage } from '../media/media-reference.types.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import { ExportFailureV1 } from './export-errors.js';
import {
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

interface MediaProjectionRow extends RowDataPacket {
  mediaId: Buffer;
  mediaType: ExportResourceMediaTypeV1;
  bytes: Buffer;
  byteLength: number;
  sha256: Buffer;
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

const usageKey = (usage: ExportProjectionResourceV1['usage']): string =>
  usage.kind === 'media'
    ? `media:${usage.mediaId}`
    : usage.kind === 'artifact'
      ? `artifact:${usage.artifactId}:${usage.versionId}`
      : `font:${usage.subset}`;

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
  ) {}

  async project(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      boardId: BoardId;
      revisionId: RevisionId | null;
      sessionId: string;
    },
  ): Promise<ExportProjectionBundleV1> {
    const revision = await this.lockRevision(connection, input);
    const hold = await this.holds.acquire(connection, {
      boardPk: input.boardPk,
      revisionPk: databasePk(revision.revisionPk),
      holderId: input.sessionId,
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
      const resources: ExportResourceCollectionV1 = {
        descriptors: new Map(),
        bytes: new Map(),
      };
      await this.addMediaResources(
        connection,
        databasePk(revision.revisionPk),
        input.sessionId,
        resources,
      );
      await this.addArtifactResources(
        connection,
        input.boardId,
        document,
        formatPublicUuidV4(revision.revisionId) as RevisionId,
        input.sessionId,
        resources,
      );
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
        revisionId: formatPublicUuidV4(revision.revisionId) as RevisionId,
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
      const projectionBytes = Buffer.from(canonicalizeExportProjectionV1(projection), 'utf8');
      if (projectionBytes.byteLength > EXPORT_PROJECTION_MAX_BYTES_V1)
        throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
      return Object.freeze({
        projection,
        projectionBytes,
        projectionSha256: sha256(projectionBytes).toString('hex'),
        resourceBytes: new Map(
          [...resources.bytes].map(([digest, resource]) => [digest, Buffer.from(resource.bytes)]),
        ),
        hold,
      });
    } catch (error) {
      await this.holds.release(connection, hold).catch(() => undefined);
      throw error;
    }
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
    sessionId: string,
    output: ExportResourceCollectionV1,
  ): Promise<void> {
    const [rows] = await connection.execute<MediaProjectionRow[]>(
      `SELECT r.media_id AS mediaId, o.mime AS mediaType, o.bytes,
              o.byte_length AS byteLength, o.sha256
       FROM board_revision_media_refs r
       JOIN board_media m ON m.media_id = r.media_id AND m.board_pk = r.board_pk
       JOIN media_objects o ON o.media_pk = m.media_pk
       WHERE r.revision_pk = ? AND m.status = 'active' AND o.state = 'active'
       ORDER BY r.ordinal`,
      [revisionPk.toString()],
    );
    for (const row of rows) {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(row.mediaType) ||
        row.bytes.byteLength !== row.byteLength ||
        row.sha256.byteLength !== 32 ||
        !timingSafeEqual(sha256(row.bytes), row.sha256)
      )
        throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
      this.addResource(
        output,
        sessionId,
        row.mediaType,
        row.bytes,
        { kind: 'media', mediaId: decodeMediaIdFromStorage(row.mediaId) },
        row.sha256.toString('hex'),
      );
    }
  }

  private async addArtifactResources(
    connection: PoolConnection,
    boardId: BoardId,
    document: BoardDocumentV3,
    revisionId: RevisionId,
    sessionId: string,
    output: ExportResourceCollectionV1,
  ): Promise<void> {
    const inventory = new Map<string, { artifact: ArtifactReferenceV1 }>();
    for (const item of collectDocumentNodesV2(document)) {
      if (item.node.type !== 'content.artifact') continue;
      const key = `${item.node.artifact.artifactId}\0${item.node.artifact.versionId}`;
      if (!inventory.has(key)) inventory.set(key, { artifact: item.node.artifact });
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
      const artifact = await this.artifacts.readImmutablePackage(connection, boardId, reference);
      const bytes = encodeArtifactPackageV1(artifact.manifestBytes, artifact.resources);
      this.addResource(output, sessionId, EXPORT_ARTIFACT_PACKAGE_MEDIA_TYPE_V1, bytes, {
        kind: 'artifact',
        artifactId: reference.artifactId,
        versionId: reference.versionId,
      });
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
