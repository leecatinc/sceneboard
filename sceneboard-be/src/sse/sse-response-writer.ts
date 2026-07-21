import { Injectable } from '@nestjs/common';

export interface SseWritableResponseV1 {
  write(chunk: Uint8Array): boolean;
  once(event: 'drain', listener: () => void): unknown;
  off(event: 'drain', listener: () => void): unknown;
}

const EVENT_PREFIX = Buffer.from('event: board.event.v1\n', 'ascii');
const DATA_PREFIX = Buffer.from('data: ', 'ascii');
const ID_PREFIX = Buffer.from('id: ', 'ascii');
const RECORD_END = Buffer.from('\n\n', 'ascii');
const KEEPALIVE = Buffer.from(': leecat-board-keepalive\n\n', 'ascii');

const frame = (canonicalBytes: Uint8Array, cursor: string | null): Buffer => {
  const parts = [EVENT_PREFIX];
  if (cursor !== null)
    parts.push(ID_PREFIX, Buffer.from(cursor, 'ascii'), Buffer.from('\n', 'ascii'));
  parts.push(DATA_PREFIX, Buffer.from(canonicalBytes), RECORD_END);
  return Buffer.concat(parts);
};

@Injectable()
export class SseResponseWriter {
  encodeEvent(canonicalBytes: Uint8Array, cursor: string | null): Buffer {
    return frame(canonicalBytes, cursor);
  }

  encodeKeepalive(): Buffer {
    return Buffer.from(KEEPALIVE);
  }

  async write(response: SseWritableResponseV1, bytes: Uint8Array): Promise<void> {
    if (response.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        response.off('drain', onDrain);
        reject(new Error('SSE drain timeout'));
      }, 5_000);
      timeout.unref();
      const onDrain = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      response.once('drain', onDrain);
    });
  }
}
