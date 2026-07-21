import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  canonicalizeJsonV1,
  type BoardId,
  type EventId,
} from '@sceneboard/board-schema';

const FINGERPRINT = /^[A-Za-z0-9_-]{22}$/u;
const MAX_HINT_BYTES = 512;

export type DurableBoardEventHintV1 = {
  v: 1;
  kind: 'durable';
  boardFp: string;
  eventId: EventId;
  sequence: number;
};

export type PresenceBoardEventHintV1 = {
  v: 1;
  kind: 'presence';
  boardFp: string;
  version: number;
};

export type BoardEventHintV1 = DurableBoardEventHintV1 | PresenceBoardEventHintV1;

export const encodeDurableBoardEventHintV1 = (
  boardFp: string,
  eventId: EventId,
  sequence: number,
): string => {
  if (!FINGERPRINT.test(boardFp)) throw new TypeError('board fingerprint is invalid');
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new TypeError('event sequence is invalid');
  const canonical = canonicalizeJsonV1({ v: 1, kind: 'durable', boardFp, eventId, sequence });
  if (!canonical.ok) throw new TypeError('event hint is invalid');
  const encoded = Buffer.from(canonical.data.canonicalBytes).toString('utf8');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_HINT_BYTES)
    throw new TypeError('event hint is too large');
  return encoded;
};

export const parseDurableBoardEventHintV1 = (
  source: string,
  expectedBoardFp: string,
): DurableBoardEventHintV1 | null => {
  if (!FINGERPRINT.test(expectedBoardFp) || Buffer.byteLength(source, 'utf8') > MAX_HINT_BYTES)
    return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    record.v !== 1 ||
    record.kind !== 'durable' ||
    record.boardFp !== expectedBoardFp ||
    typeof record.eventId !== 'string' ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1
  )
    return null;
  const canonical = canonicalizeJsonV1(value);
  if (!canonical.ok || Buffer.from(canonical.data.canonicalBytes).toString('utf8') !== source)
    return null;
  const eventId = GlobalIdStringParserV1.parse(record.eventId);
  if (!eventId.ok) return null;
  return {
    v: 1,
    kind: 'durable',
    boardFp: expectedBoardFp,
    eventId: eventId.data.value as EventId,
    sequence: record.sequence as number,
  };
};

export const encodePresenceBoardEventHintV1 = (boardFp: string, version: number): string => {
  if (!FINGERPRINT.test(boardFp)) throw new TypeError('board fingerprint is invalid');
  if (!Number.isSafeInteger(version) || version < 1)
    throw new TypeError('presence version is invalid');
  const canonical = canonicalizeJsonV1({ v: 1, kind: 'presence', boardFp, version });
  if (!canonical.ok) throw new TypeError('presence hint is invalid');
  return Buffer.from(canonical.data.canonicalBytes).toString('utf8');
};

export const parseBoardEventHintV1 = (
  source: string,
  expectedBoardFp: string,
): BoardEventHintV1 | null => {
  const durable = parseDurableBoardEventHintV1(source, expectedBoardFp);
  if (durable !== null) return durable;
  if (!FINGERPRINT.test(expectedBoardFp) || Buffer.byteLength(source, 'utf8') > MAX_HINT_BYTES)
    return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    record.v !== 1 ||
    record.kind !== 'presence' ||
    record.boardFp !== expectedBoardFp ||
    !Number.isSafeInteger(record.version) ||
    Number(record.version) < 1
  )
    return null;
  const canonical = canonicalizeJsonV1(value);
  if (!canonical.ok || Buffer.from(canonical.data.canonicalBytes).toString('utf8') !== source)
    return null;
  return { v: 1, kind: 'presence', boardFp: expectedBoardFp, version: record.version as number };
};

export const assertBoardIdV1 = (value: BoardId): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('board ID is invalid');
  return parsed.data.value;
};
