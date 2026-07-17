import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  canonicalizeJsonV1,
  type BoardId,
  type EventId,
  type TimestampV1,
} from '@leecat-board/board-schema';

import { invalidBoardPayload } from '../common/errors/board-error.factory.js';
import { BoardContractError } from '../common/errors/app-error.js';
import { RedisStreamKeyspace } from '../redis/redis-stream-keyspace.js';

export type SseResumeCursorPayloadV1 = {
  v: 1;
  k: 'event' | 'snapshot';
  b: BoardId;
  s: number;
  e: EventId;
  t: TimestampV1;
};

const PREFIX = 'lcbse_v1';
const MAC_CONTEXT = Buffer.from('leecat-board/sse-resume-cursor/v1\0', 'ascii');
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const invalidCursor = (): BoardContractError => new BoardContractError(
  invalidBoardPayload('invalid SSE resume cursor'),
);

const decodeBase64Url = (value: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalidCursor();
  return decoded;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => (
  left.byteLength === right.byteLength && timingSafeEqual(left, right)
);

@Injectable()
export class SseCursorCodec {
  readonly #key: Buffer;

  constructor(@Inject(RedisStreamKeyspace) keyspace: RedisStreamKeyspace) {
    this.#key = keyspace.cursorKey();
  }

  createSnapshotEventId(): EventId {
    return `sse_snapshot_${randomBytes(16).toString('base64url')}` as EventId;
  }

  encode(payload: SseResumeCursorPayloadV1): string {
    const validated = this.#validatePayload(payload);
    const canonical = canonicalizeJsonV1(validated);
    if (!canonical.ok) throw invalidCursor();
    const payloadPart = Buffer.from(canonical.data.canonicalBytes).toString('base64url');
    const macPart = createHmac('sha256', this.#key)
      .update(MAC_CONTEXT)
      .update(canonical.data.canonicalBytes)
      .digest('base64url');
    const cursor = `${PREFIX}.${payloadPart}.${macPart}`;
    if (cursor.length > 512 || macPart.length !== 43) throw invalidCursor();
    return cursor;
  }

  decode(cursor: string): SseResumeCursorPayloadV1 {
    if (cursor.length < 1 || cursor.length > 512) throw invalidCursor();
    const parts = cursor.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX || parts[1] === undefined || parts[2] === undefined) {
      throw invalidCursor();
    }
    const payloadBytes = decodeBase64Url(parts[1]);
    const receivedMac = decodeBase64Url(parts[2]);
    if (receivedMac.byteLength !== 32) throw invalidCursor();
    const expectedMac = createHmac('sha256', this.#key).update(MAC_CONTEXT).update(payloadBytes).digest();
    if (!equalBytes(receivedMac, expectedMac)) throw invalidCursor();
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
    } catch {
      throw invalidCursor();
    }
    const validated = this.#validatePayload(decoded);
    const canonical = canonicalizeJsonV1(validated);
    if (!canonical.ok || !equalBytes(payloadBytes, canonical.data.canonicalBytes)) throw invalidCursor();
    return validated;
  }

  isTimeUsable(payload: SseResumeCursorPayloadV1, now = Date.now()): boolean {
    const issuedAt = Date.parse(payload.t);
    return issuedAt >= now - 15 * 60_000 && issuedAt <= now + 30_000;
  }

  #validatePayload(value: unknown): SseResumeCursorPayloadV1 {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor();
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    if (keys.join(',') !== 'b,e,k,s,t,v' || source.v !== 1
      || (source.k !== 'event' && source.k !== 'snapshot')
      || !Number.isSafeInteger(source.s) || Number(source.s) < 1
      || typeof source.e !== 'string' || !GlobalIdStringParserV1.parse(source.e).ok
      || typeof source.t !== 'string' || !TIMESTAMP_PATTERN.test(source.t)
      || !Number.isFinite(Date.parse(source.t)) || new Date(Date.parse(source.t)).toISOString() !== source.t) {
      throw invalidCursor();
    }
    const board = BoardIdParserV1.parse(source.b);
    if (!board.ok) throw invalidCursor();
    return {
      v: 1,
      k: source.k,
      b: board.data.value,
      s: source.s as number,
      e: source.e as EventId,
      t: source.t as TimestampV1,
    };
  }
}
