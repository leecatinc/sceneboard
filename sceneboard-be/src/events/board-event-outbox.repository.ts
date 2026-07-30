import { createHash, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  BoardIdParserV1,
  BoardEventEnvelopeParserV2,
  type BoardId,
  type EventId,
  type RevisionId,
} from '@sceneboard/board-schema';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { formatPublicUuidV4, parsePublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { MysqlService } from '../database/mysql.service.js';
import type {
  BoardEventDeliveryPortV1,
  BoardEventHeadV1,
  DeliverableBoardEventV1,
  PendingBoardEventCandidateV1,
} from './ports/board-event-delivery.port.js';
import type {
  BoardEventOutboxHealthPortV1,
  BoardEventOutboxHealthV1,
} from './ports/board-event-outbox-health.port.js';

interface CandidateRow extends RowDataPacket {
  eventPk: string;
  eventId: Buffer;
}

interface EventRow extends CandidateRow {
  boardId: string;
  revisionId: Buffer | null;
  sequenceNumber: string;
  eventType: string;
  eventPayload: Buffer;
  eventCanonicalBytes: number;
  eventSha256: Buffer;
}

interface HeadRow extends RowDataPacket {
  boardId: string;
  revisionId: Buffer;
  lastEventSequence: string;
}

interface HealthRow extends RowDataPacket {
  oldestPendingAgeMs: string | null;
}

const safeBigInt = (value: string): bigint => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error('invalid database integer');
  return BigInt(value);
};

const safeSequence = (value: string): number => {
  const parsed = Number(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('invalid event sequence');
  }
  return parsed;
};

const asBoardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new Error('invalid stored board id');
  return parsed.data.value;
};
const asRevisionId = (value: Buffer): RevisionId => formatPublicUuidV4(value) as RevisionId;
const asEventId = (value: Buffer): EventId => formatPublicUuidV4(value) as EventId;

const equalDigest = (bytes: Buffer, digest: Buffer): boolean => {
  const actual = createHash('sha256').update(bytes).digest();
  return digest.byteLength === actual.byteLength && timingSafeEqual(digest, actual);
};

@Injectable()
export class BoardEventOutboxRepository
  implements BoardEventDeliveryPortV1, BoardEventOutboxHealthPortV1
{
  #quarantinedCorruptPending = false;

  constructor(@Inject(MysqlService) private readonly mysql: MysqlService) {}

  async listPendingCandidates(limit = 100): Promise<readonly PendingBoardEventCandidateV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('candidate limit must be 1..100');
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.query<CandidateRow[]>(
        `
        SELECT CAST(event_pk AS CHAR) AS eventPk, event_id AS eventId
        FROM board_event_outbox FORCE INDEX (ix_outbox_pending)
        WHERE status_code = 'P'
        ORDER BY event_pk ASC
        LIMIT ?
      `,
        [limit],
      );
      return rows.map((row) => ({
        eventPk: safeBigInt(row.eventPk),
        eventId: asEventId(row.eventId),
      }));
    });
  }

  async loadPendingEvent(
    candidate: PendingBoardEventCandidateV1,
  ): Promise<DeliverableBoardEventV1 | null> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.query<EventRow[]>(
        `
        SELECT CAST(o.event_pk AS CHAR) AS eventPk, o.event_id AS eventId,
          b.public_id AS boardId, r.revision_id AS revisionId,
          CAST(o.sequence_number AS CHAR) AS sequenceNumber,
          o.event_type AS eventType, o.event_payload AS eventPayload,
          o.event_canonical_bytes AS eventCanonicalBytes, o.event_sha256 AS eventSha256
        FROM board_event_outbox o
        JOIN boards b ON b.board_pk = o.board_pk
        LEFT JOIN board_revisions r ON r.board_pk = o.board_pk AND r.revision_pk = o.revision_pk
        WHERE o.event_pk = ? AND o.event_id = ? AND o.status_code = 'P'
        LIMIT 1
      `,
        [candidate.eventPk.toString(), Buffer.from(parsePublicUuidV4(candidate.eventId))],
      );
      const row = rows[0];
      if (row === undefined) return null;
      try {
        const event = this.#mapEvent(row);
        if (event.eventPk !== candidate.eventPk || event.eventId !== candidate.eventId)
          throw new Error('candidate drift');
        return event;
      } catch (error) {
        this.#quarantinedCorruptPending = true;
        throw error;
      }
    });
  }

  async markDelivered(eventPk: bigint): Promise<boolean> {
    return this.mysql.withConnection(async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        `
        UPDATE board_event_outbox
        SET status_code = 'D', delivered_at = UTC_TIMESTAMP(3),
          retain_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY)
        WHERE event_pk = ? AND status_code = 'P'
      `,
        [eventPk.toString()],
      );
      return result.affectedRows === 1;
    });
  }

  async getHead(boardId: BoardId): Promise<BoardEventHeadV1 | null> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.query<HeadRow[]>(
        `
        SELECT b.public_id AS boardId, r.revision_id AS revisionId,
          CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
        FROM boards b
        JOIN board_heads h ON h.board_pk = b.board_pk
        JOIN board_revisions r ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
        WHERE b.public_id = ?
        LIMIT 1
      `,
        [boardId],
      );
      const row = rows[0];
      return row === undefined
        ? null
        : {
            boardId: asBoardId(row.boardId),
            headRevisionId: asRevisionId(row.revisionId),
            lastEventSequence: safeSequence(row.lastEventSequence),
          };
    });
  }

  async getEvent(boardId: BoardId, sequence: number): Promise<DeliverableBoardEventV1 | null> {
    const rows = await this.#readRange(boardId, sequence - 1, 1);
    const event = rows[0];
    return event?.sequence === sequence ? event : null;
  }

  async listContiguousEvents(
    boardId: BoardId,
    afterSequence: number,
    limit = 100,
  ): Promise<readonly DeliverableBoardEventV1[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new TypeError('afterSequence is invalid');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new TypeError('range limit must be 1..1000');
    const rows = await this.#readRange(boardId, afterSequence, limit);
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index]?.sequence !== afterSequence + index + 1)
        throw new Error('event range is not contiguous');
    }
    return rows;
  }

  async getHealth(): Promise<BoardEventOutboxHealthV1> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.query<HealthRow[]>(`
        SELECT CAST(GREATEST(0, TIMESTAMPDIFF(MICROSECOND, occurred_at, UTC_TIMESTAMP(3)) DIV 1000) AS CHAR)
          AS oldestPendingAgeMs
        FROM board_event_outbox FORCE INDEX (ix_outbox_pending)
        WHERE status_code = 'P'
        ORDER BY event_pk ASC
        LIMIT 1
      `);
      const value = rows[0]?.oldestPendingAgeMs;
      const oldestPendingAgeMs = value === undefined || value === null ? 0 : safeSequence(value);
      return { oldestPendingAgeMs, quarantinedCorruptPending: this.#quarantinedCorruptPending };
    });
  }

  async #readRange(
    boardId: BoardId,
    afterSequence: number,
    limit: number,
  ): Promise<DeliverableBoardEventV1[]> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.query<EventRow[]>(
        `
        SELECT CAST(o.event_pk AS CHAR) AS eventPk, o.event_id AS eventId,
          b.public_id AS boardId, r.revision_id AS revisionId,
          CAST(o.sequence_number AS CHAR) AS sequenceNumber,
          o.event_type AS eventType, o.event_payload AS eventPayload,
          o.event_canonical_bytes AS eventCanonicalBytes, o.event_sha256 AS eventSha256
        FROM boards b
        JOIN board_event_outbox o FORCE INDEX (uq_outbox_board_sequence) ON o.board_pk = b.board_pk
        LEFT JOIN board_revisions r ON r.board_pk = o.board_pk AND r.revision_pk = o.revision_pk
        WHERE b.public_id = ? AND o.sequence_number > ?
        ORDER BY o.sequence_number ASC
        LIMIT ?
      `,
        [boardId, afterSequence, limit],
      );
      return rows.map((row) => this.#mapEvent(row));
    });
  }

  #mapEvent(row: EventRow): DeliverableBoardEventV1 {
    if (
      row.eventPayload.byteLength !== row.eventCanonicalBytes ||
      !equalDigest(row.eventPayload, row.eventSha256)
    ) {
      throw new Error('event payload integrity failure');
    }
    const parsed = BoardEventEnvelopeParserV2.parseBytes(row.eventPayload);
    if (!parsed.ok) throw new Error('stored event schema failure');
    const eventPk = safeBigInt(row.eventPk);
    const eventId = asEventId(row.eventId);
    const boardId = asBoardId(row.boardId);
    const revisionId = row.revisionId === null ? null : asRevisionId(row.revisionId);
    const sequence = safeSequence(row.sequenceNumber);
    const envelope = parsed.data.value;
    if (
      envelope.eventId !== eventId ||
      envelope.boardId !== boardId ||
      envelope.revisionId !== revisionId ||
      envelope.sequence !== sequence ||
      envelope.data.type !== row.eventType
    ) {
      throw new Error('stored event relational correlation failure');
    }
    return {
      eventPk,
      eventId,
      boardId,
      revisionId,
      sequence,
      eventType: envelope.data.type,
      envelope,
      canonicalBytes: parsed.data.canonicalBytes,
    };
  }
}
