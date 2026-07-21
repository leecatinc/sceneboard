import type { BoardId, PageCursorV1 } from '@sceneboard/board-schema';

import {
  decodeSignedCursorV1,
  encodeSignedCursorV1,
  invalidCursorV1,
} from '../common/cursors/signed-cursor.js';
import type { CursorMacKeyV1 } from '../common/security/cursor-mac-key.js';

export class HistoryCursorCodec {
  constructor(private readonly key: CursorMacKeyV1) {}

  issue(boardId: BoardId, beforeRevisionNumber: number): PageCursorV1 {
    this.assertRevisionNumber(beforeRevisionNumber);
    return encodeSignedCursorV1(
      this.key,
      Buffer.from(
        JSON.stringify({
          v: 1,
          k: 'history',
          b: boardId,
          n: beforeRevisionNumber,
        }),
        'utf8',
      ),
    );
  }

  parse(cursor: string, boardId: BoardId): number {
    const { payload, decoded } = decodeSignedCursorV1(this.key, cursor);
    if (
      Object.keys(decoded).join(',') !== 'v,k,b,n' ||
      decoded.v !== 1 ||
      decoded.k !== 'history' ||
      decoded.b !== boardId ||
      typeof decoded.n !== 'number'
    ) {
      throw invalidCursorV1();
    }
    this.assertRevisionNumber(decoded.n);
    const canonical = Buffer.from(
      JSON.stringify({ v: 1, k: 'history', b: boardId, n: decoded.n }),
      'utf8',
    );
    if (!payload.equals(canonical)) throw invalidCursorV1();
    return decoded.n;
  }

  private assertRevisionNumber(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) throw invalidCursorV1();
  }
}
