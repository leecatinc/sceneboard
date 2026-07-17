import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  ArtifactManifestParserV1,
  ArtifactRuntimeSummaryParserV1,
  BOARD_LIMITS_V1,
  type ArtifactManifestV1,
  type ArtifactReferenceV1,
  type ArtifactRuntimeSummaryV1,
  type BoardErrorCodeV1,
  type TimestampV1,
} from '@leecat-board/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';
import type { LockedControlMutationHeadV1 } from '../revisions/control-mutation.repository.js';
import type { PreparedArtifactPublicationV1, PreparedArtifactResourceV1 } from './artifact-package.builder.js';

interface ArtifactIdentityRow extends RowDataPacket {
  artifactPk: string;
}

interface OrdinalRow extends RowDataPacket {
  versionOrdinal: string;
}

interface UsageRow extends RowDataPacket {
  artifactCount: string;
  versionCount: string;
  resourceCount: string;
  manifestCanonicalBytes: string;
  resourceBytes: string;
}

interface StoredVersionRow extends RowDataPacket {
  boardPk: string;
  versionPk: string;
  manifestPayload: Buffer;
  manifestCanonicalBytes: number;
  manifestSha256: Buffer;
  resourceCount: number;
  resourceTotalBytes: number;
  statusCode: string;
  failureCode: string | null;
  failureMessage: string | null;
  lastEventSequence: string;
  updatedAt: string;
}

interface StoredResourceRow extends RowDataPacket {
  resourceOrdinal: number;
  resourcePath: string;
  mediaType: string;
  resourceSha256: Buffer;
  resourceBytes: number;
  resourcePayload?: Buffer;
}

interface LockedRuntimeRow extends StoredVersionRow {}

export type CertifiedArtifactVersionV1 = {
  boardPk: string;
  versionPk: string;
  manifest: ArtifactManifestV1;
  manifestBytes: Buffer;
  runtime: ArtifactRuntimeSummaryV1;
  lastEventSequence: number;
  resources: readonly PreparedArtifactResourceV1[];
};

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();
const equalDigest = (left: Uint8Array, right: Uint8Array): boolean => (
  left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
);

const internalFailure = (): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INTERNAL_ERROR',
  message: 'Internal error',
  category: 'internal',
  retryable: false,
  httpStatusHint: 500,
  details: null,
});

const artifactNotFound = (artifact: ArtifactReferenceV1): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'ARTIFACT_NOT_FOUND',
  message: 'Artifact not found',
  category: 'not_found',
  retryable: false,
  httpStatusHint: 404,
  details: { artifact },
});

const parseUnsigned = (value: string, maximum = MAX_UNSIGNED_BIGINT): bigint => {
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = BigInt(value);
  if (parsed > maximum) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

const insertedPk = (result: ResultSetHeader): bigint => {
  if (result.affectedRows !== 1 || !Number.isSafeInteger(result.insertId) || result.insertId < 1) {
    throw internalFailure();
  }
  return BigInt(result.insertId);
};

const actorCode = (context: AuthorizedBoardContextV1): 'U' | 'M' | 'S' => {
  if (context.actor.principalKind === 'user') return 'U';
  if (context.actor.principalKind === 'mcp_client') return 'M';
  return 'S';
};

const capabilityMask = (capabilities: ArtifactManifestV1['requestedCapabilities']): number => (
  capabilities.reduce((mask, capability) => {
    const index = ARTIFACT_REQUEST_CAPABILITIES_V1.indexOf(capability);
    if (index < 0) throw internalFailure();
    return mask | (1 << index);
  }, 0)
);

const statusValue = (code: string): ArtifactRuntimeSummaryV1['status'] => {
  if (code === 'R') return 'ready';
  if (code === 'S') return 'stopped';
  if (code === 'F') return 'failed';
  if (code === 'B') return 'blocked';
  throw new BoardPersistenceError('row_integrity');
};

const limitFailure = (
  limit: 'maxBoardArtifacts' | 'maxBoardArtifactVersions' | 'maxBoardArtifactResourceRows' | 'maxBoardArtifactChargedBytes',
  actual: bigint,
): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'LIMIT_EXCEEDED',
  message: 'Contract limit exceeded',
  category: 'validation',
  retryable: false,
  httpStatusHint: 422,
  details: { limit, actual: Number(actual), maximum: BOARD_LIMITS_V1[limit], path: ['artifact'] },
});

const nextUsage = (
  row: UsageRow,
  publication: PreparedArtifactPublicationV1,
  createsArtifact: boolean,
): { artifacts: bigint; versions: bigint; resources: bigint; manifestBytes: bigint; resourceBytes: bigint } => {
  const artifacts = parseUnsigned(row.artifactCount) + (createsArtifact ? 1n : 0n);
  const versions = parseUnsigned(row.versionCount) + 1n;
  const resources = parseUnsigned(row.resourceCount) + BigInt(publication.resources.length);
  const manifestBytes = parseUnsigned(row.manifestCanonicalBytes) + BigInt(publication.manifestBytes.byteLength);
  const resourceBytes = parseUnsigned(row.resourceBytes)
    + BigInt(publication.resources.reduce((total, item) => total + item.byteLength, 0));
  if (artifacts > BigInt(BOARD_LIMITS_V1.maxBoardArtifacts)) throw limitFailure('maxBoardArtifacts', artifacts);
  if (versions > BigInt(BOARD_LIMITS_V1.maxBoardArtifactVersions)) throw limitFailure('maxBoardArtifactVersions', versions);
  if (resources > BigInt(BOARD_LIMITS_V1.maxBoardArtifactResourceRows)) {
    throw limitFailure('maxBoardArtifactResourceRows', resources);
  }
  if (manifestBytes + resourceBytes > BigInt(BOARD_LIMITS_V1.maxBoardArtifactChargedBytes)) {
    throw limitFailure('maxBoardArtifactChargedBytes', manifestBytes + resourceBytes);
  }
  return { artifacts, versions, resources, manifestBytes, resourceBytes };
};

export class ArtifactRepository {
  async publish(
    connection: PoolConnection,
    input: {
      head: LockedControlMutationHeadV1;
      context: AuthorizedBoardContextV1;
      requestId: string;
      publication: PreparedArtifactPublicationV1;
      artifactIdWasSupplied: boolean;
      sequence: number;
      occurredAtSql: string;
    },
  ): Promise<ArtifactRuntimeSummaryV1> {
    const artifact = input.publication.manifest.artifact;
    const [identityRows] = await connection.execute<ArtifactIdentityRow[]>(`
      SELECT CAST(artifact_pk AS CHAR) AS artifactPk
      FROM artifacts
      WHERE board_pk = ? AND artifact_id = ?
      LIMIT 1
    `, [input.head.boardPk, artifact.artifactId]);
    if (identityRows.length > 1) throw internalFailure();
    let artifactPk: bigint;
    let versionOrdinal = 1n;
    const existing = identityRows[0];
    if (existing === undefined) {
      const [insert] = await connection.execute<ResultSetHeader>(`
        INSERT INTO artifacts (
          board_pk, artifact_id, created_by_kind, created_by_principal_id,
          created_by_grant_id, created_request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        input.head.boardPk,
        artifact.artifactId,
        actorCode(input.context),
        input.context.actor.principalId,
        input.context.actor.grantId,
        input.requestId,
        input.occurredAtSql,
      ]);
      artifactPk = insertedPk(insert);
    } else {
      if (!input.artifactIdWasSupplied) throw internalFailure();
      artifactPk = parseUnsigned(existing.artifactPk);
      const [ordinalRows] = await connection.execute<OrdinalRow[]>(`
        SELECT CAST(version_ordinal AS CHAR) AS versionOrdinal
        FROM artifact_versions
        WHERE artifact_pk = ?
        ORDER BY version_ordinal DESC
        LIMIT 1
      `, [artifactPk.toString()]);
      const latest = ordinalRows[0];
      if (ordinalRows.length !== 1 || latest === undefined) throw internalFailure();
      versionOrdinal = parseUnsigned(latest.versionOrdinal, BigInt(Number.MAX_SAFE_INTEGER)) + 1n;
    }
    await connection.execute<ResultSetHeader>(`
      INSERT INTO artifact_board_usage (
        board_pk, artifact_count, version_count, resource_count,
        manifest_canonical_bytes, resource_bytes, updated_at
      ) VALUES (?, 0, 0, 0, 0, 0, ?)
      ON DUPLICATE KEY UPDATE board_pk = board_pk
    `, [input.head.boardPk, input.occurredAtSql]);
    const [usageRows] = await connection.execute<UsageRow[]>(`
      SELECT CAST(artifact_count AS CHAR) AS artifactCount,
             CAST(version_count AS CHAR) AS versionCount,
             CAST(resource_count AS CHAR) AS resourceCount,
             CAST(manifest_canonical_bytes AS CHAR) AS manifestCanonicalBytes,
             CAST(resource_bytes AS CHAR) AS resourceBytes
      FROM artifact_board_usage
      WHERE board_pk = ?
      FOR UPDATE
    `, [input.head.boardPk]);
    const usageRow = usageRows[0];
    if (usageRows.length !== 1 || usageRow === undefined) throw internalFailure();
    const usage = nextUsage(usageRow, input.publication, existing === undefined);
    const [versionInsert] = await connection.execute<ResultSetHeader>(`
      INSERT INTO artifact_versions (
        board_pk, artifact_pk, version_id, version_ordinal, entry_path,
        manifest_payload, manifest_canonical_bytes, manifest_sha256,
        requested_capability_mask, sanitizer_policy_version,
        resource_count, resource_total_bytes, created_by_kind,
        created_by_principal_id, created_by_grant_id, created_request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.head.boardPk,
      artifactPk.toString(),
      artifact.versionId,
      versionOrdinal.toString(),
      input.publication.manifest.entryPath,
      input.publication.manifestBytes,
      input.publication.manifestBytes.byteLength,
      input.publication.manifestSha256,
      capabilityMask(input.publication.manifest.requestedCapabilities),
      input.publication.resources.length,
      input.publication.resources.reduce((total, item) => total + item.byteLength, 0),
      actorCode(input.context),
      input.context.actor.principalId,
      input.context.actor.grantId,
      input.requestId,
      input.occurredAtSql,
    ]);
    const versionPk = insertedPk(versionInsert);
    for (let index = 0; index < input.publication.resources.length; index += 1) {
      const resource = input.publication.resources[index];
      if (resource === undefined) throw internalFailure();
      const [insert] = await connection.execute<ResultSetHeader>(`
        INSERT INTO artifact_resources (
          version_pk, resource_ordinal, resource_path, media_type,
          resource_sha256, resource_bytes, resource_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        versionPk.toString(),
        index + 1,
        resource.path,
        resource.mediaType,
        Buffer.from(resource.sha256, 'hex'),
        resource.byteLength,
        resource.bytes,
      ]);
      insertedPk(insert);
    }
    const [runtimeInsert] = await connection.execute<ResultSetHeader>(`
      INSERT INTO artifact_runtime_states (
        version_pk, status_code, failure_code, failure_message,
        last_event_sequence, updated_at
      ) VALUES (?, 'R', NULL, NULL, ?, ?)
    `, [versionPk.toString(), input.sequence, input.occurredAtSql]);
    if (runtimeInsert.affectedRows !== 1) throw internalFailure();
    const [usageUpdate] = await connection.execute<ResultSetHeader>(`
      UPDATE artifact_board_usage
      SET artifact_count = ?, version_count = ?, resource_count = ?,
          manifest_canonical_bytes = ?, resource_bytes = ?, updated_at = ?
      WHERE board_pk = ?
    `, [
      usage.artifacts.toString(),
      usage.versions.toString(),
      usage.resources.toString(),
      usage.manifestBytes.toString(),
      usage.resourceBytes.toString(),
      input.occurredAtSql,
      input.head.boardPk,
    ]);
    if (usageUpdate.affectedRows !== 1) throw internalFailure();
    const parsed = ArtifactRuntimeSummaryParserV1.parse({
      artifact,
      status: 'ready',
      updatedAt: parseMysqlTimestampUtc(input.occurredAtSql).toISOString(),
      failure: null,
    });
    if (!parsed.ok) throw internalFailure();
    return parsed.data.value;
  }

  async readVersion(
    connection: PoolConnection,
    boardId: string,
    artifact: ArtifactReferenceV1,
    includeBytes: boolean,
  ): Promise<CertifiedArtifactVersionV1> {
    const [rows] = await connection.execute<StoredVersionRow[]>(`
      SELECT CAST(b.board_pk AS CHAR) AS boardPk,
             CAST(v.version_pk AS CHAR) AS versionPk,
             v.manifest_payload AS manifestPayload,
             v.manifest_canonical_bytes AS manifestCanonicalBytes,
             v.manifest_sha256 AS manifestSha256,
             v.resource_count AS resourceCount,
             v.resource_total_bytes AS resourceTotalBytes,
             s.status_code AS statusCode, s.failure_code AS failureCode,
             s.failure_message AS failureMessage,
             CAST(s.last_event_sequence AS CHAR) AS lastEventSequence,
             s.updated_at AS updatedAt
      FROM boards b
      JOIN artifacts a ON a.board_pk = b.board_pk
      JOIN artifact_versions v ON v.artifact_pk = a.artifact_pk AND v.board_pk = a.board_pk
      JOIN artifact_runtime_states s ON s.version_pk = v.version_pk
      WHERE b.public_id = ? AND a.artifact_id = ? AND v.version_id = ?
      LIMIT 1
    `, [boardId, artifact.artifactId, artifact.versionId]);
    const row = rows[0];
    if (rows.length === 0) throw artifactNotFound(artifact);
    if (rows.length !== 1 || row === undefined) throw internalFailure();
    const payloadColumn = includeBytes ? ', resource_payload AS resourcePayload' : '';
    const [resourceRows] = await connection.execute<StoredResourceRow[]>(`
      SELECT resource_ordinal AS resourceOrdinal,
             CONVERT(resource_path USING utf8mb4) AS resourcePath,
             media_type AS mediaType, resource_sha256 AS resourceSha256,
             resource_bytes AS resourceBytes${payloadColumn}
      FROM artifact_resources
      WHERE version_pk = ?
      ORDER BY resource_ordinal ASC
    `, [row.versionPk]);
    return this.certify(row, resourceRows, artifact, includeBytes);
  }

  async lockRuntime(
    connection: PoolConnection,
    boardPk: string,
    artifact: ArtifactReferenceV1,
  ): Promise<CertifiedArtifactVersionV1> {
    const [rows] = await connection.execute<LockedRuntimeRow[]>(`
      SELECT CAST(a.board_pk AS CHAR) AS boardPk,
             CAST(v.version_pk AS CHAR) AS versionPk,
             v.manifest_payload AS manifestPayload,
             v.manifest_canonical_bytes AS manifestCanonicalBytes,
             v.manifest_sha256 AS manifestSha256,
             v.resource_count AS resourceCount,
             v.resource_total_bytes AS resourceTotalBytes,
             s.status_code AS statusCode, s.failure_code AS failureCode,
             s.failure_message AS failureMessage,
             CAST(s.last_event_sequence AS CHAR) AS lastEventSequence,
             s.updated_at AS updatedAt
      FROM artifacts a
      JOIN artifact_versions v ON v.artifact_pk = a.artifact_pk AND v.board_pk = a.board_pk
      JOIN artifact_runtime_states s ON s.version_pk = v.version_pk
      WHERE a.board_pk = ? AND a.artifact_id = ? AND v.version_id = ?
      FOR UPDATE
    `, [boardPk, artifact.artifactId, artifact.versionId]);
    const row = rows[0];
    if (rows.length === 0) throw artifactNotFound(artifact);
    if (rows.length !== 1 || row === undefined) throw internalFailure();
    const [resourceRows] = await connection.execute<StoredResourceRow[]>(`
      SELECT resource_ordinal AS resourceOrdinal,
             CONVERT(resource_path USING utf8mb4) AS resourcePath,
             media_type AS mediaType, resource_sha256 AS resourceSha256,
             resource_bytes AS resourceBytes
      FROM artifact_resources
      WHERE version_pk = ?
      ORDER BY resource_ordinal ASC
    `, [row.versionPk]);
    return this.certify(row, resourceRows, artifact, false);
  }

  async markStopped(
    connection: PoolConnection,
    versionPk: string,
    sequence: number,
    occurredAtSql: string,
  ): Promise<void> {
    const [update] = await connection.execute<ResultSetHeader>(`
      UPDATE artifact_runtime_states
      SET status_code = 'S', failure_code = NULL, failure_message = NULL,
          last_event_sequence = ?, updated_at = ?
      WHERE version_pk = ? AND status_code = 'R'
    `, [sequence, occurredAtSql, versionPk]);
    if (update.affectedRows !== 1) throw internalFailure();
  }

  private certify(
    row: StoredVersionRow,
    resourceRows: readonly StoredResourceRow[],
    artifact: ArtifactReferenceV1,
    includeBytes: boolean,
  ): CertifiedArtifactVersionV1 {
    if (row.manifestCanonicalBytes !== row.manifestPayload.byteLength
      || !equalDigest(row.manifestSha256, digest(row.manifestPayload))) throw internalFailure();
    const manifest = ArtifactManifestParserV1.parseBytes(row.manifestPayload);
    if (!manifest.ok || manifest.data.value.artifact.artifactId !== artifact.artifactId
      || manifest.data.value.artifact.versionId !== artifact.versionId
      || manifest.data.value.resources.length !== row.resourceCount
      || resourceRows.length !== row.resourceCount) throw internalFailure();
    let totalBytes = 0;
    const resources = resourceRows.map((resourceRow, index): PreparedArtifactResourceV1 => {
      const descriptor = manifest.data.value.resources[index];
      if (descriptor === undefined || resourceRow.resourceOrdinal !== index + 1
        || resourceRow.resourcePath !== descriptor.path
        || resourceRow.mediaType !== descriptor.mediaType
        || resourceRow.resourceBytes !== descriptor.byteLength
        || !equalDigest(resourceRow.resourceSha256, Buffer.from(descriptor.sha256, 'hex'))) {
        throw internalFailure();
      }
      const bytes = resourceRow.resourcePayload ?? Buffer.alloc(0);
      if (includeBytes && (bytes.byteLength !== descriptor.byteLength
        || !equalDigest(digest(bytes), resourceRow.resourceSha256))) throw internalFailure();
      totalBytes += descriptor.byteLength;
      return { ...descriptor, bytes };
    });
    if (totalBytes !== row.resourceTotalBytes) throw internalFailure();
    const runtime = ArtifactRuntimeSummaryParserV1.parse({
      artifact,
      status: statusValue(row.statusCode),
      updatedAt: parseMysqlTimestampUtc(row.updatedAt).toISOString() as TimestampV1,
      failure: row.failureCode === null || row.failureMessage === null
        ? null
        : { code: row.failureCode as BoardErrorCodeV1, message: row.failureMessage },
    });
    if (!runtime.ok) throw internalFailure();
    const lastEventSequence = Number(parseUnsigned(row.lastEventSequence, BigInt(Number.MAX_SAFE_INTEGER)));
    if (lastEventSequence < 1) throw internalFailure();
    return {
      boardPk: row.boardPk,
      versionPk: row.versionPk,
      manifest: manifest.data.value,
      manifestBytes: Buffer.from(row.manifestPayload),
      runtime: runtime.data.value,
      lastEventSequence,
      resources,
    };
  }
}
