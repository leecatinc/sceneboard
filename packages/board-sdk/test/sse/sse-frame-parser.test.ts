import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BoardEventEnvelopeParserV1,
  canonicalizeJsonV1,
  type BoardEventEnvelopeV1,
} from '@sceneboard/board-schema';

import { createSseFrameParserV1, SseProtocolErrorV1 } from '../../src/sse/sse-frame-parser.js';

const fixtureRoot = new URL('../../../board-schema/test/fixtures/valid/', import.meta.url);
const encoder = new TextEncoder();

const readEvent = (name: string): BoardEventEnvelopeV1 => {
  const parsed = BoardEventEnvelopeParserV1.parse(
    JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid event fixture');
  return parsed.data.value;
};

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const frame = (
  event: BoardEventEnvelopeV1,
  cursor: string | null,
  delimiter: '\n' | '\r\n' = '\n',
): Uint8Array => {
  const canonical = canonicalizeJsonV1(event);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) throw new Error('event fixture canonicalization failed');
  return concat(
    encoder.encode(`event: board.event.v1${delimiter}`),
    cursor === null ? new Uint8Array() : encoder.encode(`id: ${cursor}${delimiter}`),
    encoder.encode('data: '),
    canonical.data.canonicalBytes,
    encoder.encode(`${delimiter}${delimiter}`),
  );
};

test('parses durable LF and CRLF records with the exact opaque cursor', () => {
  const event = readEvent('event-board-snapshot.v1.json');
  for (const delimiter of ['\n', '\r\n'] as const) {
    const parser = createSseFrameParserV1();
    const records = parser.push(frame(event, 'cursor_1', delimiter));
    parser.finish();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, 'event');
    if (records[0]?.kind !== 'event') continue;
    assert.equal(records[0].input.cursor, 'cursor_1');
    assert.deepEqual(records[0].input.envelope, event);
  }
});

test('supports arbitrary transport fragmentation without decoding partial UTF-8', () => {
  const bytes = frame(readEvent('event-board-snapshot.v1.json'), 'cursor_fragmented');
  const parser = createSseFrameParserV1();
  const records = [];
  for (const byte of bytes) records.push(...parser.push(Uint8Array.of(byte)));
  parser.finish();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.kind, 'event');
});

test('accepts empty and UTF-8 comment keepalives without producing board data', () => {
  const parser = createSseFrameParserV1();
  assert.deepEqual(parser.push(encoder.encode('\n')), []);
  assert.deepEqual(parser.push(encoder.encode(': leecat-board-keepalive\n\n')), [
    { kind: 'keepalive' },
  ]);
  assert.deepEqual(parser.push(encoder.encode(': 상태\r\n: ok\r\n\r\n')), [{ kind: 'keepalive' }]);
  parser.finish();
});

test('rejects cursor cardinality, unknown fields, mixed comments, and mixed delimiters', () => {
  const snapshot = readEvent('event-board-snapshot.v1.json');
  const presence = readEvent('event-presence-updated.v1.json');
  const malformed = [
    frame(snapshot, null),
    frame(presence, 'forbidden_cursor'),
    encoder.encode('event: board.event.v1\nunknown: x\ndata: {}\n\n'),
    encoder.encode(': keepalive\nevent: board.event.v1\ndata: {}\n\n'),
    encoder.encode('event: board.event.v1\r\ndata: {}\n\n'),
  ];
  for (const bytes of malformed) {
    const parser = createSseFrameParserV1();
    assert.throws(() => parser.push(bytes), SseProtocolErrorV1);
  }
});

test('distinguishes clean EOF from every incomplete line or record', () => {
  const clean = createSseFrameParserV1();
  clean.push(frame(readEvent('event-board-snapshot.v1.json'), 'cursor_1'));
  clean.finish();

  for (const bytes of [
    encoder.encode('event: board.event.v1'),
    encoder.encode('event: board.event.v1\n'),
    encoder.encode(': partial'),
  ]) {
    const parser = createSseFrameParserV1();
    parser.push(bytes);
    assert.throws(() => parser.finish(), SseProtocolErrorV1);
  }
});

test('rejects BOM, forbidden controls, malformed comment UTF-8, and overlong cursors', () => {
  const invalidInputs = [
    Uint8Array.of(0xef, 0xbb, 0xbf, 0x0a),
    encoder.encode(': a\u0000b\n\n'),
    Uint8Array.of(0x3a, 0x20, 0xff, 0x0a, 0x0a),
    encoder.encode(`event: board.event.v1\nid: ${'a'.repeat(513)}\ndata: {}\n\n`),
  ];
  for (const bytes of invalidInputs) {
    const parser = createSseFrameParserV1();
    assert.throws(() => parser.push(bytes), SseProtocolErrorV1);
  }
});
