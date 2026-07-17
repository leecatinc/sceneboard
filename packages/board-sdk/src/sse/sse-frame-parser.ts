import {
  BOARD_LIMITS_V1,
  BoardEventEnvelopeParserV1,
  type BoardErrorV1,
} from '@leecat-board/board-schema';

import type { BoardEventReconcileInputV1 } from '../events/index.js';

export type ParsedSseRecordV1 =
  | { kind: 'keepalive' }
  | { kind: 'event'; input: BoardEventReconcileInputV1 };

export class SseProtocolErrorV1 extends Error {
  constructor(
    message: string,
    readonly boardError: BoardErrorV1 | null = null,
  ) {
    super(message);
    this.name = 'SseProtocolErrorV1';
  }
}

export type SseFrameParserV1 = {
  push(chunk: Uint8Array): ParsedSseRecordV1[];
  finish(): void;
};

const EVENT_LINE_BYTES = 21;
const MAX_CURSOR_BYTES = BOARD_LIMITS_V1.maxPageCursorChars;
const MAX_ID_LINE_BYTES = 4 + MAX_CURSOR_BYTES;
const MAX_DATA_LINE_BYTES = 6 + BOARD_LIMITS_V1.maxEnvelopeBytes;
const MAX_RECORD_BYTES_LF = 1_049_123;
const MAX_RECORD_BYTES_CRLF = 1_049_127;
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

const isVisibleAscii = (bytes: Uint8Array): boolean => {
  for (const byte of bytes) if (byte < 0x21 || byte > 0x7e) return false;
  return true;
};

const equalAscii = (bytes: Uint8Array, expected: string): boolean => {
  if (bytes.byteLength !== expected.length) return false;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== expected.charCodeAt(index)) return false;
  }
  return true;
};

const decodeAscii = (bytes: Uint8Array): string => {
  if (!isVisibleAscii(bytes)) throw new SseProtocolErrorV1('SSE value must use visible ASCII');
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
};

const joinData = (parts: readonly Uint8Array[]): Uint8Array => {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0) + parts.length - 1;
  if (byteLength > BOARD_LIMITS_V1.maxEnvelopeBytes) {
    throw new SseProtocolErrorV1('SSE data exceeds the D1 envelope byte limit');
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    if (index > 0) output[offset++] = 0x0a;
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const parseRecord = (lines: readonly Uint8Array[]): ParsedSseRecordV1 | null => {
  if (lines.length === 0) return null;
  let commentCount = 0;
  let eventSeen = false;
  let idSeen = false;
  let dataSeen = false;
  let cursor: string | null = null;
  const dataParts: Uint8Array[] = [];

  for (const line of lines) {
    if (line.byteLength === 0) throw new SseProtocolErrorV1('unexpected empty line in SSE record');
    if (line[0] === 0x3a) {
      if (eventSeen || idSeen || dataSeen) throw new SseProtocolErrorV1('comments and fields cannot be mixed');
      try {
        fatalDecoder.decode(line);
      } catch {
        throw new SseProtocolErrorV1('SSE comment contains malformed UTF-8');
      }
      commentCount += 1;
      continue;
    }
    if (commentCount > 0) throw new SseProtocolErrorV1('comments and fields cannot be mixed');
    const colon = line.indexOf(0x3a);
    if (colon <= 0) throw new SseProtocolErrorV1('SSE field line requires a non-empty name and colon');
    for (let index = 0; index < colon; index += 1) {
      const byte = line[index];
      if (byte === undefined || byte < 0x21 || byte > 0x7e) {
        throw new SseProtocolErrorV1('SSE field name must be visible ASCII');
      }
    }
    const field = new TextDecoder().decode(line.subarray(0, colon));
    const valueStart = line[colon + 1] === 0x20 ? colon + 2 : colon + 1;
    const value = line.subarray(valueStart);
    if (field === 'event') {
      if (eventSeen || idSeen || dataSeen || line.byteLength !== EVENT_LINE_BYTES) {
        throw new SseProtocolErrorV1('event must be the first exact singleton field');
      }
      if (!equalAscii(value, 'board.event.v1')) throw new SseProtocolErrorV1('unknown SSE event name');
      eventSeen = true;
      continue;
    }
    if (field === 'id') {
      if (!eventSeen || idSeen || dataSeen || line.byteLength > MAX_ID_LINE_BYTES || value.byteLength < 1) {
        throw new SseProtocolErrorV1('id must be one non-empty field before data');
      }
      cursor = decodeAscii(value);
      if (cursor.length > MAX_CURSOR_BYTES) throw new SseProtocolErrorV1('SSE cursor is too long');
      idSeen = true;
      continue;
    }
    if (field === 'data') {
      if (!eventSeen || line.byteLength > MAX_DATA_LINE_BYTES) {
        throw new SseProtocolErrorV1('data must follow the event field within its byte limit');
      }
      dataSeen = true;
      dataParts.push(value.slice());
      continue;
    }
    throw new SseProtocolErrorV1('unknown SSE field');
  }
  if (commentCount > 0) return { kind: 'keepalive' };
  if (!eventSeen || !dataSeen) throw new SseProtocolErrorV1('SSE board record is incomplete');
  const dataBytes = joinData(dataParts);
  const parsed = BoardEventEnvelopeParserV1.parseBytes(dataBytes);
  if (!parsed.ok) throw new SseProtocolErrorV1('invalid D1 board event envelope', parsed.error);
  const durable = parsed.data.value.data.type === 'board.snapshot'
    || parsed.data.value.data.type === 'board.revision.created'
    || parsed.data.value.data.type === 'hitl.updated'
    || parsed.data.value.data.type === 'artifact.status.changed';
  if ((durable && cursor === null) || (!durable && cursor !== null)) {
    throw new SseProtocolErrorV1('SSE cursor cardinality does not match the event kind');
  }
  return {
    kind: 'event',
    input: {
      envelope: parsed.data.value,
      canonicalBytes: parsed.data.canonicalBytes,
      cursor,
    },
  };
};

export const createSseFrameParserV1 = (): SseFrameParserV1 => {
  let pending = new Uint8Array(0);
  let recordLines: Uint8Array[] = [];
  let recordBytes = 0;
  let delimiter: 'lf' | 'crlf' | null = null;
  let firstBytesChecked = false;

  const push = (chunk: Uint8Array): ParsedSseRecordV1[] => {
    if (!(chunk instanceof Uint8Array)) throw new SseProtocolErrorV1('SSE chunk must be bytes');
    if (chunk.byteLength === 0) return [];
    const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
    combined.set(pending);
    combined.set(chunk, pending.byteLength);
    if (!firstBytesChecked && combined.byteLength >= 3) {
      firstBytesChecked = true;
      if (combined[0] === 0xef && combined[1] === 0xbb && combined[2] === 0xbf) {
        throw new SseProtocolErrorV1('UTF-8 BOM is forbidden');
      }
    }
    const output: ParsedSseRecordV1[] = [];
    let lineStart = 0;
    for (let index = 0; index < combined.byteLength; index += 1) {
      const byte = combined[index];
      if (byte === 0x00 || (byte !== 0x0a && byte !== 0x0d && byte !== undefined && byte < 0x20)) {
        throw new SseProtocolErrorV1('SSE contains a forbidden control byte');
      }
      if (byte !== 0x0a) continue;
      const hasCr = index > lineStart && combined[index - 1] === 0x0d;
      const style = hasCr ? 'crlf' : 'lf';
      if (delimiter !== null && delimiter !== style) throw new SseProtocolErrorV1('mixed SSE line delimiters');
      delimiter = style;
      const lineEnd = hasCr ? index - 1 : index;
      const line = combined.slice(lineStart, lineEnd);
      recordBytes += index - lineStart + 1;
      const maximumRecordBytes = style === 'lf' ? MAX_RECORD_BYTES_LF : MAX_RECORD_BYTES_CRLF;
      if (recordBytes > maximumRecordBytes) throw new SseProtocolErrorV1('SSE record byte limit exceeded');
      if (line.byteLength === 0) {
        const parsed = parseRecord(recordLines);
        if (parsed !== null) output.push(parsed);
        recordLines = [];
        recordBytes = 0;
        delimiter = null;
      } else {
        if (line.includes(0x0d)) throw new SseProtocolErrorV1('bare CR is forbidden');
        recordLines.push(line);
      }
      lineStart = index + 1;
    }
    pending = combined.slice(lineStart);
    const maximumPendingRecordBytes = delimiter === 'lf' ? MAX_RECORD_BYTES_LF : MAX_RECORD_BYTES_CRLF;
    if (recordBytes + pending.byteLength > maximumPendingRecordBytes) {
      throw new SseProtocolErrorV1('SSE record byte limit exceeded');
    }
    return output;
  };

  const finish = (): void => {
    if (pending.byteLength > 0 || recordLines.length > 0 || recordBytes > 0) {
      throw new SseProtocolErrorV1('SSE stream ended with an incomplete record');
    }
  };

  return { push, finish };
};
