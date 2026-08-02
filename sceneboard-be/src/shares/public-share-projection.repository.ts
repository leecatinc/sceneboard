import {
  PublicBoardProjectionParserV1,
  adaptLegacySceneToDocumentV2,
  collectArtifactReferencesAcrossSnapshotV2,
  type ArtifactRuntimeSummaryV1,
  type ArtifactReferenceV1,
  type BoardDocument,
  type PublicBoardProjectionV1,
  type PublicArtifactSummaryV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { ArtifactRepository } from '../artifacts/artifact.repository.js';
import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import {
  decodeMediaIdFromStorage,
  decodePageIdFromStorage,
} from '../media/media-reference.types.js';
import type { RevisionMediaReferenceRowV1 } from '../media/media-reference.types.js';
import { RevisionMediaReferenceExtractor } from '../media/revision-media-reference.extractor.js';
import type { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import {
  extractDocumentArtifactReferences,
  type SceneArtifactReferenceRowV1,
} from '../revisions/scene-artifact-reference.extractor.js';
import type { ResolvedPublicShare } from './public-share.resolver.js';
import type { PublicMediaProjectionPort } from './public-media-projection.port.js';
import { PublicShareHttpError } from './public-share.error.js';

interface RevisionRow extends RowDataPacket {
  revisionPk: string;
  revisionId: Buffer;
  schemaVersion: string;
  codec: string;
  payload: Buffer;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
}

interface ArtifactReferenceRow extends RowDataPacket {
  artifactId: string;
  versionId: string;
  referenceCode: string;
  occurrenceCount: number;
}

interface MediaReferenceRow extends RowDataPacket {
  mediaId: Buffer;
  firstPageId: Buffer;
  ordinal: number;
}

type LockedRevision = Omit<RevisionRow, 'revisionPk'> & { revisionPk: bigint };

const databasePk = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new PublicShareHttpError(503);
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new PublicShareHttpError(503);
  return parsed;
};

const artifactKey = (artifact: { artifactId: string; versionId: string }): string =>
  `${artifact.artifactId}\0${artifact.versionId}`;

export class PublicShareProjectionRepository {
  constructor(
    private readonly checkpoints: DocumentCheckpointCodec,
    private readonly artifacts: ArtifactRepository,
    private readonly mediaReferences: RevisionMediaReferenceExtractor,
    private readonly media: PublicMediaProjectionPort,
  ) {}

  async build(resolved: ResolvedPublicShare, contextId: string): Promise<PublicBoardProjectionV1> {
    const revision = await this.lockRevision(resolved);
    const decoded = await this.checkpoints.decode({
      schemaVersion: revision.schemaVersion,
      codec: revision.codec,
      payload: revision.payload,
      canonicalBytes: revision.canonicalBytes,
      storedBytes: revision.storedBytes,
      sha256: revision.sha256,
    });
    const document: BoardDocument =
      decoded.kind === 'document'
        ? decoded.document
        : adaptLegacySceneToDocumentV2({ boardId: resolved.boardId, scene: decoded.scene });
    const runtimes = await this.readArtifactInventory(resolved, document);
    const orderedArtifacts = collectArtifactReferencesAcrossSnapshotV2({
      boardId: resolved.boardId,
      revisionId: resolved.share.pinnedRevisionId,
      snapshot: {
        boardId: resolved.boardId,
        revision: { revisionId: resolved.share.pinnedRevisionId },
        document,
        artifacts: runtimes,
      },
    });
    await this.assertArtifactReferences(
      resolved.connection,
      revision.revisionPk,
      extractDocumentArtifactReferences(document),
    );
    const publicArtifacts: PublicArtifactSummaryV1[] = orderedArtifacts.map((reference) => {
      const runtime = runtimes.find(
        (candidate) =>
          candidate.artifact.artifactId === reference.artifactId &&
          candidate.artifact.versionId === reference.versionId,
      );
      if (runtime === undefined) throw new PublicShareHttpError(503);
      return runtime.status === 'ready'
        ? {
            artifactId: reference.artifactId,
            versionId: reference.versionId,
            status: 'ready',
            packageUrl: this.artifactUrl(resolved, contextId, reference),
          }
        : {
            artifactId: reference.artifactId,
            versionId: reference.versionId,
            status: runtime.status,
            packageUrl: null,
          };
    });
    const freshMedia = this.mediaReferences.extract({
      boardId: resolved.boardId,
      revisionId: resolved.share.pinnedRevisionId,
      document,
    });
    await this.assertMediaReferences(resolved.connection, revision.revisionPk, freshMedia);
    const publicMedia = await this.media.read(resolved.connection, {
      boardPk: resolved.share.boardPk,
      revisionPk: revision.revisionPk,
      boardId: resolved.boardId,
      revisionId: resolved.share.pinnedRevisionId,
      shareId: resolved.share.shareId,
      publicationGeneration: resolved.share.publicationGeneration,
      accessGeneration: resolved.share.accessGeneration,
      contextId,
      references: freshMedia,
    });
    const parsed = PublicBoardProjectionParserV1.parse({
      shareId: resolved.share.shareId,
      boardId: resolved.boardId,
      revisionId: resolved.share.pinnedRevisionId,
      publicationGeneration: resolved.share.publicationGeneration,
      accessGeneration: resolved.share.accessGeneration,
      title: resolved.title,
      document,
      artifacts: publicArtifacts,
      media: publicMedia,
    });
    if (!parsed.ok) throw new PublicShareHttpError(503);
    return parsed.data.value;
  }

  private async lockRevision(resolved: ResolvedPublicShare): Promise<LockedRevision> {
    const [rows] = await resolved.connection.execute<RevisionRow[]>(
      `SELECT CAST(r.revision_pk AS CHAR) AS revisionPk, r.revision_id AS revisionId,
              p.schema_version AS schemaVersion, p.codec, p.payload,
              p.canonical_bytes AS canonicalBytes, p.stored_bytes AS storedBytes,
              p.payload_sha256 AS sha256
       FROM board_revisions r
       JOIN board_revision_catalog c
         ON c.board_pk = r.board_pk AND c.revision_pk = r.revision_pk
       JOIN board_revision_payloads p
         ON p.revision_pk = r.revision_pk AND p.state = 'available'
       WHERE r.board_pk = ? AND r.revision_pk = ?
       LIMIT 1 FOR UPDATE`,
      [resolved.share.boardPk.toString(), resolved.share.pinnedRevisionPk.toString()],
    );
    const row = rows[0];
    if (rows.length === 0 || row === undefined) throw new PublicShareHttpError(404);
    if (rows.length !== 1 || formatPublicUuidV4(row.revisionId) !== resolved.share.pinnedRevisionId)
      throw new PublicShareHttpError(503);
    return { ...row, revisionPk: databasePk(row.revisionPk) };
  }

  private async readArtifactInventory(
    resolved: ResolvedPublicShare,
    document: BoardDocument,
  ): Promise<ArtifactRuntimeSummaryV1[]> {
    const pairs = new Map<string, ArtifactReferenceV1>();
    const stack = document.pages.flatMap((page) =>
      page.scene.root === null ? [] : [page.scene.root],
    );
    while (stack.length > 0) {
      const node = stack.shift();
      if (node === undefined) break;
      if (
        node.type === 'layout.split' ||
        node.type === 'layout.grid' ||
        node.type === 'layout.canvas'
      )
        stack.unshift(...node.children.map((child) => child.node));
      else if (node.type === 'layout.tabs') stack.unshift(...node.tabs.map((tab) => tab.node));
      const pair =
        node.type === 'content.artifact'
          ? node.artifact
          : node.type === 'content.image' && node.source.type === 'artifact.resource'
            ? node.source.artifact
            : null;
      if (pair === null) continue;
      if (!pairs.has(artifactKey(pair))) pairs.set(artifactKey(pair), pair);
    }
    const output: ArtifactRuntimeSummaryV1[] = [];
    for (const pair of pairs.values()) {
      try {
        const certified = await this.artifacts.readVersion(
          resolved.connection,
          resolved.boardId,
          pair,
          false,
        );
        output.push(certified.runtime);
      } catch (error) {
        if (error instanceof BoardPersistenceError) throw new PublicShareHttpError(503);
        throw new PublicShareHttpError(503);
      }
    }
    return output;
  }

  private async assertArtifactReferences(
    connection: PoolConnection,
    revisionPk: bigint,
    fresh: readonly SceneArtifactReferenceRowV1[],
  ): Promise<void> {
    const [rows] = await connection.execute<ArtifactReferenceRow[]>(
      `SELECT artifact_id AS artifactId, artifact_version_id AS versionId,
              reference_code AS referenceCode, occurrence_count AS occurrenceCount
       FROM board_revision_artifact_refs
       WHERE revision_pk = ?
       ORDER BY artifact_id, artifact_version_id, reference_code`,
      [revisionPk.toString()],
    );
    const stored: SceneArtifactReferenceRowV1[] = [];
    for (const row of rows) {
      if (
        (row.referenceCode !== 'A' && row.referenceCode !== 'I') ||
        !Number.isSafeInteger(row.occurrenceCount) ||
        row.occurrenceCount < 1
      )
        throw new PublicShareHttpError(503);
      stored.push({
        artifactId: row.artifactId,
        artifactVersionId: row.versionId,
        referenceCode: row.referenceCode,
        occurrenceCount: row.occurrenceCount,
      });
    }
    if (JSON.stringify(stored) !== JSON.stringify(fresh)) throw new PublicShareHttpError(503);
  }

  private async assertMediaReferences(
    connection: PoolConnection,
    revisionPk: bigint,
    fresh: readonly RevisionMediaReferenceRowV1[],
  ): Promise<void> {
    const [rows] = await connection.execute<MediaReferenceRow[]>(
      `SELECT media_id AS mediaId, first_page_id AS firstPageId, ordinal
       FROM board_revision_media_refs
       WHERE revision_pk = ?
       ORDER BY ordinal`,
      [revisionPk.toString()],
    );
    if (rows.length !== fresh.length) throw new PublicShareHttpError(503);
    for (let index = 0; index < fresh.length; index += 1) {
      const expected = fresh[index];
      const actual = rows[index];
      if (
        expected === undefined ||
        actual === undefined ||
        actual.ordinal !== expected.ordinal ||
        decodeMediaIdFromStorage(actual.mediaId) !== expected.mediaId ||
        decodePageIdFromStorage(actual.firstPageId) !== expected.firstPageId
      )
        throw new PublicShareHttpError(503);
    }
  }

  private artifactUrl(
    resolved: ResolvedPublicShare,
    contextId: string,
    artifact: { artifactId: string; versionId: string },
  ): string {
    return `/api/v1/public/shares/${resolved.share.shareId}/revisions/${resolved.share.pinnedRevisionId}/g/${resolved.share.publicationGeneration}/${resolved.share.accessGeneration}/artifacts/${artifact.artifactId}/versions/${artifact.versionId}/package?contextId=${contextId}`;
  }
}
