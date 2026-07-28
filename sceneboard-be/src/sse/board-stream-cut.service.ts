import { Inject, Injectable } from '@nestjs/common';
import {
  BoardEventEnvelopeParserV2,
  type BoardEventEnvelopeV2,
  type BoardId,
  type BoardSnapshot,
  type RequestId,
  type TimestampV1,
} from '@sceneboard/board-schema';

import { BoardGetService } from '../boards/board-get.service.js';
import { CryptoService } from '../common/security/crypto.service.js';
import type {
  BoardEventDeliveryPortV1,
  DeliverableBoardEventV1,
} from '../events/ports/board-event-delivery.port.js';
import { BOARD_EVENT_DELIVERY_PORT_V1 } from '../events/ports/board-event-delivery.tokens.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { SseCursorCodec } from './sse-cursor.codec.js';

export type PreparedBoardStreamFrameV1 = {
  envelope: BoardEventEnvelopeV2;
  canonicalBytes: Uint8Array;
  cursor: string;
};

export type PreparedBoardStreamCutV1 = {
  frames: readonly PreparedBoardStreamFrameV1[];
  sequence: number;
};

@Injectable()
export class BoardStreamCutService {
  constructor(
    @Inject(BoardGetService) private readonly boards: BoardGetService,
    @Inject(BOARD_EVENT_DELIVERY_PORT_V1) private readonly events: BoardEventDeliveryPortV1,
    @Inject(SseCursorCodec) private readonly cursors: SseCursorCodec,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async prepare(
    principal: ResolvedBoardPrincipalV1,
    boardId: BoardId,
    cursorSource: string | null,
  ): Promise<PreparedBoardStreamCutV1> {
    const snapshot = await this.#authorizedSnapshot(principal, boardId);
    const watermark = snapshot.lastEventSequence;
    if (cursorSource === null) return this.#snapshotCut(snapshot);
    const cursor = this.cursors.decode(cursorSource);
    if (
      cursor.b !== boardId ||
      !this.cursors.isTimeUsable(cursor) ||
      cursor.s > watermark ||
      watermark - cursor.s > 1_000
    )
      return this.#snapshotCut(snapshot);
    if (cursor.k === 'event') {
      const correlated = await this.events.getEvent(boardId, cursor.s);
      if (correlated === null || correlated.eventId !== cursor.e)
        return this.#snapshotCut(snapshot);
    }
    const events = await this.#range(boardId, cursor.s, watermark);
    if (events === null) return this.#snapshotCut(snapshot);
    return { frames: events.map((event) => this.eventFrame(event)), sequence: watermark };
  }

  async reauthorize(principal: ResolvedBoardPrincipalV1, boardId: BoardId): Promise<number> {
    return (await this.#authorizedSnapshot(principal, boardId)).lastEventSequence;
  }

  async rangeAfter(
    boardId: BoardId,
    afterSequence: number,
    headSequence: number,
  ): Promise<PreparedBoardStreamFrameV1[] | null> {
    const events = await this.#range(boardId, afterSequence, headSequence);
    return events?.map((event) => this.eventFrame(event)) ?? null;
  }

  eventFrame(event: DeliverableBoardEventV1): PreparedBoardStreamFrameV1 {
    const issuedAt = new Date().toISOString() as TimestampV1;
    return {
      envelope: event.envelope,
      canonicalBytes: event.canonicalBytes,
      cursor: this.cursors.encode({
        v: 1,
        k: 'event',
        b: event.boardId,
        s: event.sequence,
        e: event.eventId,
        t: issuedAt,
      }),
    };
  }

  async #authorizedSnapshot(
    principal: ResolvedBoardPrincipalV1,
    boardId: BoardId,
  ): Promise<BoardSnapshot> {
    const result = await this.boards.get({
      principal,
      requestId: this.crypto.generatePublicIdV1() as RequestId,
      boardId,
    });
    if (result.result.type !== 'board.get') throw new Error('board snapshot result drift');
    return result.result.snapshot;
  }

  #snapshotCut(snapshot: BoardSnapshot): PreparedBoardStreamCutV1 {
    const occurredAt = new Date().toISOString() as TimestampV1;
    const eventId = this.cursors.createSnapshotEventId();
    const parsed = BoardEventEnvelopeParserV2.parse({
      protocolVersion: 1,
      type: 'board.event',
      boardId: snapshot.boardId,
      eventId,
      sequence: snapshot.lastEventSequence,
      occurredAt,
      revisionId: snapshot.revision.revisionId,
      data: { type: 'board.snapshot', snapshot },
    });
    if (!parsed.ok) throw new Error('snapshot event composition failure');
    return {
      sequence: snapshot.lastEventSequence,
      frames: [
        {
          envelope: parsed.data.value,
          canonicalBytes: parsed.data.canonicalBytes,
          cursor: this.cursors.encode({
            v: 1,
            k: 'snapshot',
            b: snapshot.boardId,
            s: snapshot.lastEventSequence,
            e: eventId,
            t: occurredAt,
          }),
        },
      ],
    };
  }

  async #range(
    boardId: BoardId,
    after: number,
    head: number,
  ): Promise<DeliverableBoardEventV1[] | null> {
    const output: DeliverableBoardEventV1[] = [];
    let sequence = after;
    while (sequence < head) {
      const rows = await this.events.listContiguousEvents(
        boardId,
        sequence,
        Math.min(100, head - sequence),
      );
      if (rows.length === 0) return null;
      output.push(...rows);
      sequence = rows.at(-1)?.sequence ?? sequence;
      if (output.length > 1_000) return null;
    }
    return sequence === head ? output : null;
  }
}
