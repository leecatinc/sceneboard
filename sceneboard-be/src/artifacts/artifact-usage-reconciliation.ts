import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { ArtifactAuditService } from './artifact-audit.service.js';

interface UsageRow extends RowDataPacket {
  artifactCount: string;
  versionCount: string;
  resourceCount: string;
  manifestCanonicalBytes: string;
  resourceBytes: string;
}

interface ArtifactRow extends RowDataPacket {
  artifactPk: string;
}

interface VersionRow extends RowDataPacket {
  versionPk: string;
  manifestCanonicalBytes: number;
  resourceCount: number;
  resourceTotalBytes: number;
}

interface ResourceRow extends RowDataPacket {
  resourcePk: string;
  resourceBytes: number;
}

export type ArtifactUsageReconciliationReportV1 = {
  boardPk: string;
  drift: boolean;
  stored: {
    artifactCount: string;
    versionCount: string;
    resourceCount: string;
    manifestCanonicalBytes: string;
    resourceBytes: string;
  };
  computed: {
    artifactCount: string;
    versionCount: string;
    resourceCount: string;
    manifestCanonicalBytes: string;
    resourceBytes: string;
  };
  aggregateColumnsMatchResources: boolean;
};

const unsigned = (value: string): bigint => {
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

const pk = (value: string): string => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new BoardPersistenceError('row_integrity');
  unsigned(value);
  return value;
};

export class ArtifactUsageReconciliation {
  constructor(private readonly audit?: ArtifactAuditService) {}

  async inspectBoard(
    connection: PoolConnection,
    boardPk: string,
    batchSize = 500,
  ): Promise<ArtifactUsageReconciliationReportV1> {
    pk(boardPk);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new BoardPersistenceError('capacity_exhausted');
    }
    const [usageRows] = await connection.execute<UsageRow[]>(
      `
      SELECT CAST(artifact_count AS CHAR) AS artifactCount,
             CAST(version_count AS CHAR) AS versionCount,
             CAST(resource_count AS CHAR) AS resourceCount,
             CAST(manifest_canonical_bytes AS CHAR) AS manifestCanonicalBytes,
             CAST(resource_bytes AS CHAR) AS resourceBytes
      FROM artifact_board_usage
      WHERE board_pk = ?
    `,
      [boardPk],
    );
    const usage = usageRows[0];
    if (usageRows.length !== 1 || usage === undefined)
      throw new BoardPersistenceError('row_integrity');
    const stored = {
      artifactCount: unsigned(usage.artifactCount),
      versionCount: unsigned(usage.versionCount),
      resourceCount: unsigned(usage.resourceCount),
      manifestCanonicalBytes: unsigned(usage.manifestCanonicalBytes),
      resourceBytes: unsigned(usage.resourceBytes),
    };
    let artifactCount = 0n;
    let artifactCursor = '0';
    while (true) {
      const [rows] = await connection.execute<ArtifactRow[]>(
        `
        SELECT CAST(artifact_pk AS CHAR) AS artifactPk
        FROM artifacts
        WHERE board_pk = ? AND artifact_pk > ?
        ORDER BY artifact_pk ASC
        LIMIT ${batchSize}
      `,
        [boardPk, artifactCursor],
      );
      for (const row of rows) artifactCursor = pk(row.artifactPk);
      artifactCount += BigInt(rows.length);
      if (rows.length < batchSize) break;
    }
    let versionCount = 0n;
    let versionResourceCount = 0n;
    let versionResourceBytes = 0n;
    let manifestCanonicalBytes = 0n;
    let versionCursor = '0';
    while (true) {
      const [rows] = await connection.execute<VersionRow[]>(
        `
        SELECT CAST(version_pk AS CHAR) AS versionPk,
               manifest_canonical_bytes AS manifestCanonicalBytes,
               resource_count AS resourceCount,
               resource_total_bytes AS resourceTotalBytes
        FROM artifact_versions
        WHERE board_pk = ? AND version_pk > ?
        ORDER BY version_pk ASC
        LIMIT ${batchSize}
      `,
        [boardPk, versionCursor],
      );
      for (const row of rows) {
        versionCursor = pk(row.versionPk);
        if (
          !Number.isSafeInteger(row.manifestCanonicalBytes) ||
          row.manifestCanonicalBytes < 1 ||
          !Number.isSafeInteger(row.resourceCount) ||
          row.resourceCount < 1 ||
          !Number.isSafeInteger(row.resourceTotalBytes) ||
          row.resourceTotalBytes < 0
        ) {
          throw new BoardPersistenceError('row_integrity');
        }
        manifestCanonicalBytes += BigInt(row.manifestCanonicalBytes);
        versionResourceCount += BigInt(row.resourceCount);
        versionResourceBytes += BigInt(row.resourceTotalBytes);
      }
      versionCount += BigInt(rows.length);
      if (rows.length < batchSize) break;
    }
    let resourceCount = 0n;
    let resourceBytes = 0n;
    let resourceCursor = '0';
    while (true) {
      const [rows] = await connection.execute<ResourceRow[]>(
        `
        SELECT CAST(r.resource_pk AS CHAR) AS resourcePk, r.resource_bytes AS resourceBytes
        FROM artifact_resources r
        JOIN artifact_versions v ON v.version_pk = r.version_pk
        WHERE v.board_pk = ? AND r.resource_pk > ?
        ORDER BY r.resource_pk ASC
        LIMIT ${batchSize}
      `,
        [boardPk, resourceCursor],
      );
      for (const row of rows) {
        resourceCursor = pk(row.resourcePk);
        if (!Number.isSafeInteger(row.resourceBytes) || row.resourceBytes < 0) {
          throw new BoardPersistenceError('row_integrity');
        }
        resourceBytes += BigInt(row.resourceBytes);
      }
      resourceCount += BigInt(rows.length);
      if (rows.length < batchSize) break;
    }
    const computed = {
      artifactCount,
      versionCount,
      resourceCount,
      manifestCanonicalBytes,
      resourceBytes,
    };
    const aggregateColumnsMatchResources =
      versionResourceCount === resourceCount && versionResourceBytes === resourceBytes;
    const drift =
      Object.keys(computed).some(
        (key) => computed[key as keyof typeof computed] !== stored[key as keyof typeof stored],
      ) || !aggregateColumnsMatchResources;
    const report: ArtifactUsageReconciliationReportV1 = {
      boardPk,
      drift,
      stored: Object.fromEntries(
        Object.entries(stored).map(([key, value]) => [key, value.toString()]),
      ) as ArtifactUsageReconciliationReportV1['stored'],
      computed: Object.fromEntries(
        Object.entries(computed).map(([key, value]) => [key, value.toString()]),
      ) as ArtifactUsageReconciliationReportV1['computed'],
      aggregateColumnsMatchResources,
    };
    if (report.drift && this.audit !== undefined) {
      await this.audit.write(connection, {
        event: 'artifact.usage.drift',
        context: null,
        boardPk,
        operation: 'reconcile',
        status: 'drift',
        resultCode: 'drift',
        drift: true,
      });
    }
    return report;
  }
}
