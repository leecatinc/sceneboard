import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
} from '@leecat-board/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { MysqlService } from '../database/mysql.service.js';
import {
  PersistenceProbeFailure,
  type PersistenceCertificationProbeV1,
  type PersistenceProbeBatchResultV1,
  type PersistenceProbeIdV1,
  type PersistenceProbeInputV1,
} from './persistence-certification.types.js';

type ProbeRow = RowDataPacket & Record<string, unknown>;

type ProbeDefinition = Readonly<{
  probeId: PersistenceProbeIdV1;
  ascendingSql: string;
  lowestSql: string;
  highestSql: string;
  cursorOf(row: ProbeRow): string;
  cursorBinds(cursor: string | null): readonly unknown[];
  validate(row: ProbeRow, input: PersistenceProbeInputV1): void;
}>;

const UINT_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;

const safeUnsigned = (value: unknown, allowZero = true): string => {
  if (typeof value !== 'string' || !UINT_PATTERN.test(value) || (!allowZero && value === '0')) {
    throw new PersistenceProbeFailure('ROW_MAPPING', false);
  }
  return value;
};

const safeBytes = (value: unknown, maximum: number): Buffer => {
  if (!Buffer.isBuffer(value) || value.byteLength < 1 || value.byteLength > maximum) {
    throw new PersistenceProbeFailure('ROW_MAPPING', false);
  }
  return value;
};

const sameDigest = (payload: Buffer, digest: unknown): boolean => (
  Buffer.isBuffer(digest)
  && digest.byteLength === 32
  && timingSafeEqual(createHash('sha256').update(payload).digest(), digest)
);

const exactLength = (value: unknown, length: number): boolean => Buffer.isBuffer(value) && value.byteLength === length;

const parsedGlobalId = (value: unknown): boolean => GlobalIdStringParserV1.parse(value).ok;
const parsedBoardId = (value: unknown): boolean => BoardIdParserV1.parse(value).ok;

const numericCursor = (row: ProbeRow): string => safeUnsigned(row.cursorPk, false);
const numericBinds = (cursor: string | null): readonly unknown[] => [safeUnsigned(cursor ?? '0'), 0];

const pageSql = (projection: string, joins: string, cursorColumn: string): Pick<ProbeDefinition, 'ascendingSql' | 'lowestSql' | 'highestSql'> => ({
  ascendingSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ ${projection} ${joins} WHERE ${cursorColumn} > ? ORDER BY ${cursorColumn} ASC LIMIT ?`,
  lowestSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ ${projection} ${joins} ORDER BY ${cursorColumn} ASC LIMIT ?`,
  highestSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ ${projection} ${joins} ORDER BY ${cursorColumn} DESC LIMIT ?`,
});

const definitions: readonly ProbeDefinition[] = [
  {
    probeId: 'd2-binding-public-id-owner-fk',
    ascendingSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(gb.grant_id AS CHAR) AS grantId,
      gb.board_public_id AS boardPublicId, CAST(g.owner_user_id AS CHAR) AS grantOwnerId,
      CAST(b.owner_user_id AS CHAR) AS boardOwnerId
      FROM mcp_grant_boards gb JOIN mcp_grants g ON g.id = gb.grant_id
      JOIN boards b ON b.public_id = gb.board_public_id
      WHERE (gb.grant_id > ? OR (gb.grant_id = ? AND gb.board_public_id > ?))
      ORDER BY gb.grant_id ASC, gb.board_public_id ASC LIMIT ?`,
    lowestSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(gb.grant_id AS CHAR) AS grantId,
      gb.board_public_id AS boardPublicId, CAST(g.owner_user_id AS CHAR) AS grantOwnerId,
      CAST(b.owner_user_id AS CHAR) AS boardOwnerId
      FROM mcp_grant_boards gb JOIN mcp_grants g ON g.id = gb.grant_id
      JOIN boards b ON b.public_id = gb.board_public_id
      ORDER BY gb.grant_id ASC, gb.board_public_id ASC LIMIT ?`,
    highestSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(gb.grant_id AS CHAR) AS grantId,
      gb.board_public_id AS boardPublicId, CAST(g.owner_user_id AS CHAR) AS grantOwnerId,
      CAST(b.owner_user_id AS CHAR) AS boardOwnerId
      FROM mcp_grant_boards gb JOIN mcp_grants g ON g.id = gb.grant_id
      JOIN boards b ON b.public_id = gb.board_public_id
      ORDER BY gb.grant_id DESC, gb.board_public_id DESC LIMIT ?`,
    cursorOf: (row) => JSON.stringify([safeUnsigned(row.grantId, false), String(row.boardPublicId)]),
    cursorBinds: (cursor) => {
      if (cursor === null) return ['0', '0', '', 0];
      try {
        const parsed = JSON.parse(cursor) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== 2 || !parsedBoardId(parsed[1])) throw new TypeError();
        const grantId = safeUnsigned(parsed[0], false);
        return [grantId, grantId, parsed[1], 0];
      } catch {
        throw new PersistenceProbeFailure('CURSOR', false);
      }
    },
    validate: (row) => {
      if (!safeUnsigned(row.grantId, false)
        || !parsedBoardId(row.boardPublicId)
        || safeUnsigned(row.grantOwnerId, false) !== safeUnsigned(row.boardOwnerId, false)) {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
    },
  },
  {
    probeId: 'd3-board-public-id-owner-head',
    ...pageSql(
      `CAST(b.board_pk AS CHAR) AS cursorPk, b.public_id AS boardPublicId,
       CAST(b.owner_user_id AS CHAR) AS ownerId, CAST(u.id AS CHAR) AS existingOwnerId,
       CAST(h.board_pk AS CHAR) AS headBoardPk, CAST(h.head_revision_pk AS CHAR) AS headRevisionPk`,
      'FROM boards b JOIN users u ON u.id = b.owner_user_id LEFT JOIN board_heads h ON h.board_pk = b.board_pk',
      'b.board_pk',
    ),
    cursorOf: numericCursor,
    cursorBinds: numericBinds,
    validate: (row) => {
      const boardPk = safeUnsigned(row.cursorPk, false);
      if (!parsedBoardId(row.boardPublicId)
        || safeUnsigned(row.ownerId, false) !== safeUnsigned(row.existingOwnerId, false)
        || row.headBoardPk === null
        || safeUnsigned(row.headBoardPk, false) !== boardPk
        || safeUnsigned(row.headRevisionPk, false) === '0') {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
    },
  },
  {
    probeId: 'revision-head-lineage',
    ...pageSql(
      `CAST(r.revision_pk AS CHAR) AS cursorPk, r.revision_id AS revisionId,
       CAST(r.board_pk AS CHAR) AS boardPk, CAST(r.revision_number AS CHAR) AS revisionNumber,
       CAST(previous.board_pk AS CHAR) AS previousBoardPk, CAST(source.board_pk AS CHAR) AS sourceBoardPk,
       r.scene_stored_bytes AS sceneStoredBytes, OCTET_LENGTH(r.scene_payload) AS actualStoredBytes`,
      `FROM board_revisions r
       LEFT JOIN board_revisions previous ON previous.revision_pk = r.previous_revision_pk
       LEFT JOIN board_revisions source ON source.revision_pk = r.source_revision_pk`,
      'r.revision_pk',
    ),
    cursorOf: numericCursor,
    cursorBinds: numericBinds,
    validate: (row) => {
      const boardPk = safeUnsigned(row.boardPk, false);
      try {
        formatPublicUuidV4(safeBytes(row.revisionId, 16));
      } catch {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
      if (!safeUnsigned(row.cursorPk, false)
        || !safeUnsigned(row.revisionNumber, false)
        || (row.previousBoardPk !== null && safeUnsigned(row.previousBoardPk, false) !== boardPk)
        || (row.sourceBoardPk !== null && safeUnsigned(row.sourceBoardPk, false) !== boardPk)
        || !Number.isInteger(row.sceneStoredBytes)
        || row.sceneStoredBytes !== row.actualStoredBytes
        || Number(row.sceneStoredBytes) < 1
        || Number(row.sceneStoredBytes) > 800_000) {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
    },
  },
  {
    probeId: 'idempotency-result',
    ...pageSql(
      `CAST(i.record_pk AS CHAR) AS cursorPk, i.record_id AS recordId,
       i.status_code AS statusCode, i.fingerprint_payload AS fingerprintPayload,
       i.fingerprint_canonical_bytes AS fingerprintBytes, i.fingerprint_sha256 AS fingerprintSha256,
       i.result_payload AS resultPayload, i.result_canonical_bytes AS resultBytes,
       i.result_sha256 AS resultSha256`,
      'FROM board_idempotency_records i',
      'i.record_pk',
    ),
    cursorOf: numericCursor,
    cursorBinds: numericBinds,
    validate: (row, input) => {
      if (!exactLength(row.recordId, 16)) throw new PersistenceProbeFailure('ROW_MAPPING', false);
      const fingerprint = safeBytes(row.fingerprintPayload, input.maxPayloadBytes);
      if (row.fingerprintBytes !== fingerprint.byteLength || !sameDigest(fingerprint, row.fingerprintSha256)) {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
      if (row.statusCode === 'P') {
        if (row.resultPayload !== null || row.resultBytes !== null || row.resultSha256 !== null) {
          throw new PersistenceProbeFailure('ROW_MAPPING', false);
        }
      } else if (row.statusCode === 'C') {
        const result = safeBytes(row.resultPayload, input.maxPayloadBytes);
        if (row.resultBytes !== result.byteLength || !sameDigest(result, row.resultSha256)) {
          throw new PersistenceProbeFailure('ROW_MAPPING', false);
        }
      } else throw new PersistenceProbeFailure('ROW_MAPPING', false);
    },
  },
  {
    probeId: 'outbox-event',
    ...pageSql(
      `CAST(o.event_pk AS CHAR) AS cursorPk, o.event_id AS eventId,
       CAST(o.board_pk AS CHAR) AS boardPk, CAST(o.sequence_number AS CHAR) AS sequenceNumber,
       o.event_payload AS eventPayload, o.event_canonical_bytes AS eventBytes, o.event_sha256 AS eventSha256,
       CAST(h.last_event_sequence AS CHAR) AS headSequence`,
      'FROM board_event_outbox o JOIN board_heads h ON h.board_pk = o.board_pk',
      'o.event_pk',
    ),
    cursorOf: numericCursor,
    cursorBinds: numericBinds,
    validate: (row, input) => {
      const payload = safeBytes(row.eventPayload, input.maxPayloadBytes);
      if (!exactLength(row.eventId, 16)
        || row.eventBytes !== payload.byteLength
        || !sameDigest(payload, row.eventSha256)
        || BigInt(safeUnsigned(row.sequenceNumber, false)) > BigInt(safeUnsigned(row.headSequence))) {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
    },
  },
  {
    probeId: 'checkpoint-ref-sequence',
    ascendingSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(r.revision_pk AS CHAR) AS cursorPk,
      r.scene_payload AS scenePayload, r.scene_stored_bytes AS sceneStoredBytes, r.scene_sha256 AS sceneSha256,
      COUNT(ref.ref_pk) AS referenceCount,
      SUM(CASE WHEN ref.ref_pk IS NOT NULL AND (ref.artifact_id IS NULL OR ref.artifact_version_id IS NULL) THEN 1 ELSE 0 END) AS invalidReferenceCount
      FROM board_revisions r LEFT JOIN board_revision_artifact_refs ref ON ref.revision_pk = r.revision_pk
      WHERE r.revision_pk > ? GROUP BY r.revision_pk ORDER BY r.revision_pk ASC LIMIT ?`,
    lowestSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(r.revision_pk AS CHAR) AS cursorPk,
      r.scene_payload AS scenePayload, r.scene_stored_bytes AS sceneStoredBytes, r.scene_sha256 AS sceneSha256,
      COUNT(ref.ref_pk) AS referenceCount,
      SUM(CASE WHEN ref.ref_pk IS NOT NULL AND (ref.artifact_id IS NULL OR ref.artifact_version_id IS NULL) THEN 1 ELSE 0 END) AS invalidReferenceCount
      FROM board_revisions r LEFT JOIN board_revision_artifact_refs ref ON ref.revision_pk = r.revision_pk
      GROUP BY r.revision_pk ORDER BY r.revision_pk ASC LIMIT ?`,
    highestSql: `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(r.revision_pk AS CHAR) AS cursorPk,
      r.scene_payload AS scenePayload, r.scene_stored_bytes AS sceneStoredBytes, r.scene_sha256 AS sceneSha256,
      COUNT(ref.ref_pk) AS referenceCount,
      SUM(CASE WHEN ref.ref_pk IS NOT NULL AND (ref.artifact_id IS NULL OR ref.artifact_version_id IS NULL) THEN 1 ELSE 0 END) AS invalidReferenceCount
      FROM board_revisions r LEFT JOIN board_revision_artifact_refs ref ON ref.revision_pk = r.revision_pk
      GROUP BY r.revision_pk ORDER BY r.revision_pk DESC LIMIT ?`,
    cursorOf: numericCursor,
    cursorBinds: numericBinds,
    validate: (row, input) => {
      const payload = safeBytes(row.scenePayload, input.maxPayloadBytes);
      if (row.sceneStoredBytes !== payload.byteLength
        || !sameDigest(payload, row.sceneSha256)
        || Number(row.invalidReferenceCount ?? 0) !== 0
        || !Number.isSafeInteger(Number(row.referenceCount))) {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
    },
  },
];

const estimatedBytes = (rows: readonly ProbeRow[]): number => rows.reduce((total, row) => (
  total + Object.values(row).reduce<number>((rowTotal, value) => {
    if (Buffer.isBuffer(value)) return rowTotal + value.byteLength;
    if (typeof value === 'string') return rowTotal + Buffer.byteLength(value, 'utf8');
    if (typeof value === 'number') return rowTotal + 8;
    return rowTotal;
  }, 0)
), 0);

class MysqlPersistenceCertificationProbe implements PersistenceCertificationProbeV1 {
  readonly probeId: PersistenceProbeIdV1;

  constructor(
    private readonly mysql: MysqlService,
    private readonly definition: ProbeDefinition,
  ) {
    this.probeId = definition.probeId;
  }

  async run(input: PersistenceProbeInputV1): Promise<PersistenceProbeBatchResultV1> {
    if (input.probeId !== this.probeId || input.signal.aborted) {
      throw new PersistenceProbeFailure(input.signal.aborted ? 'INTERRUPTED' : 'ORDERING', true);
    }
    return this.mysql.withConnection((connection) => this.inReadOnlyBatch(connection, input));
  }

  private async inReadOnlyBatch(
    connection: PoolConnection,
    input: PersistenceProbeInputV1,
  ): Promise<PersistenceProbeBatchResultV1> {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    try {
      const rows = input.scope === 'bounded-canary'
        ? await this.readCanary(connection, input)
        : await this.readCompletePage(connection, input);
      if (input.signal.aborted) throw new PersistenceProbeFailure('INTERRUPTED', true);
      for (const row of rows) this.definition.validate(row, input);
      const scannedBytes = estimatedBytes(rows);
      if (!Number.isSafeInteger(scannedBytes) || scannedBytes < 0) {
        throw new PersistenceProbeFailure('ROW_MAPPING', false);
      }
      await connection.commit();
      const complete = input.scope === 'bounded-canary' || rows.length < input.maxRows;
      return {
        complete,
        nextCursor: complete ? null : this.definition.cursorOf(rows.at(-1)!),
        scannedRows: rows.length,
        scannedBytes,
        deferredRows: 0,
      };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      if (error instanceof PersistenceProbeFailure) throw error;
      throw new PersistenceProbeFailure('PROBE', false);
    }
  }

  private async readCompletePage(
    connection: PoolConnection,
    input: PersistenceProbeInputV1,
  ): Promise<ProbeRow[]> {
    const binds = [...this.definition.cursorBinds(input.cursor)];
    binds[binds.length - 1] = input.maxRows;
    const [rows] = await connection.execute<ProbeRow[]>(this.definition.ascendingSql, binds);
    return rows;
  }

  private async readCanary(
    connection: PoolConnection,
    input: PersistenceProbeInputV1,
  ): Promise<ProbeRow[]> {
    const half = Math.min(100, Math.floor(input.maxRows / 2));
    const [lowest] = await connection.execute<ProbeRow[]>(this.definition.lowestSql, [half]);
    const [highest] = await connection.execute<ProbeRow[]>(this.definition.highestSql, [half]);
    const byCursor = new Map<string, ProbeRow>();
    for (const row of [...lowest, ...highest]) byCursor.set(this.definition.cursorOf(row), row);
    return [...byCursor.values()];
  }
}

export const createMysqlPersistenceCertificationProbes = (
  mysql: MysqlService,
): readonly PersistenceCertificationProbeV1[] => definitions.map(
  (definition) => new MysqlPersistenceCertificationProbe(mysql, definition),
);
