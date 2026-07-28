import { Inject, Injectable } from '@nestjs/common';
import {
  adaptLegacySceneToDocumentV2,
  BOARD_DOCUMENT_LIMITS_V2,
  BOARD_LIMITS_V1,
  BoardEventEnvelopeParserV1,
  BoardEventEnvelopeParserV2,
  DEFAULT_BOARD_CAPABILITIES_V2,
  type BoardEventEnvelopeV1,
  type BoardEventEnvelopeV2,
  type BoardId,
  type BoardSnapshot,
  type BoardSnapshotV1,
  type BoardSnapshotV2,
  type RequestId,
  type TimestampV1,
} from '@sceneboard/board-schema';

import { BoardGetService } from '../boards/board-get.service.js';
import { BoardContractError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import type {
  BoardEventDeliveryPortV1,
  DeliverableBoardEventV1,
} from '../events/ports/board-event-delivery.port.js';
import { BOARD_EVENT_DELIVERY_PORT_V1 } from '../events/ports/board-event-delivery.tokens.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { SseCursorCodec } from './sse-cursor.codec.js';

export type PreparedBoardStreamFrameV1 = {
  envelope: BoardEventEnvelopeV1 | BoardEventEnvelopeV2;
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
    documentSchemaVersion: 1 | 2 = 1,
  ): Promise<PreparedBoardStreamCutV1> {
    const snapshot = this.#projectSnapshot(
      await this.#authorizedSnapshot(principal, boardId),
      documentSchemaVersion,
    );
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
    return {
      frames: events.map((event) => this.eventFrame(event, documentSchemaVersion)),
      sequence: watermark,
    };
  }

  async reauthorize(
    principal: ResolvedBoardPrincipalV1,
    boardId: BoardId,
    documentSchemaVersion: 1 | 2 = 1,
  ): Promise<number> {
    return this.#projectSnapshot(
      await this.#authorizedSnapshot(principal, boardId),
      documentSchemaVersion,
    ).lastEventSequence;
  }

  async rangeAfter(
    boardId: BoardId,
    afterSequence: number,
    headSequence: number,
    documentSchemaVersion: 1 | 2 = 1,
  ): Promise<PreparedBoardStreamFrameV1[] | null> {
    const events = await this.#range(boardId, afterSequence, headSequence);
    return events?.map((event) => this.eventFrame(event, documentSchemaVersion)) ?? null;
  }

  eventFrame(
    event: DeliverableBoardEventV1,
    documentSchemaVersion: 1 | 2 = 1,
  ): PreparedBoardStreamFrameV1 {
    const issuedAt = new Date().toISOString() as TimestampV1;
    const parsed =
      documentSchemaVersion === 2
        ? BoardEventEnvelopeParserV2.parseBytes(event.canonicalBytes)
        : BoardEventEnvelopeParserV1.parseBytes(event.canonicalBytes);
    if (!parsed.ok) throw new BoardContractError(parsed.error);
    const limit =
      documentSchemaVersion === 2
        ? BOARD_DOCUMENT_LIMITS_V2.maxDocumentEnvelopeBytes
        : BOARD_LIMITS_V1.maxEnvelopeBytes;
    if (parsed.data.canonicalBytes.byteLength > limit)
      throw new Error('projected SSE event exceeds negotiated envelope limit');
    return {
      envelope: parsed.data.value,
      canonicalBytes: parsed.data.canonicalBytes,
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
    const parser = 'document' in snapshot ? BoardEventEnvelopeParserV2 : BoardEventEnvelopeParserV1;
    const parsed = parser.parse({
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

  #projectSnapshot(snapshot: BoardSnapshot, documentSchemaVersion: 1 | 2): BoardSnapshot {
    if (documentSchemaVersion === 1) {
      if ('document' in snapshot) {
        throw new BoardContractError({
          protocolVersion: 1,
          type: 'board.error',
          code: 'DOCUMENT_VERSION_MISMATCH',
          message: 'Document version mismatch',
          category: 'conflict',
          retryable: false,
          httpStatusHint: 409,
          details: {
            headSchemaVersion: 2,
            commandSchemaVersion: 1,
            commandType: 'scene.replace',
          },
        });
      }
      return snapshot;
    }
    if ('document' in snapshot) return snapshot;
    const source = snapshot as BoardSnapshotV1;
    const { scene, capabilities, ...shared } = source;
    return {
      ...shared,
      document: adaptLegacySceneToDocumentV2({ boardId: source.boardId, scene }),
      capabilities: {
        ...DEFAULT_BOARD_CAPABILITIES_V2,
        supported: {
          ...DEFAULT_BOARD_CAPABILITIES_V2.supported,
          nodeTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.nodeTypes],
          commandTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.commandTypes],
          operationTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.operationTypes],
          eventTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.eventTypes],
          hitlKinds: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.hitlKinds],
          artifactRequestCapabilities: [
            ...DEFAULT_BOARD_CAPABILITIES_V2.supported.artifactRequestCapabilities,
          ],
        },
        limits: { ...DEFAULT_BOARD_CAPABILITIES_V2.limits },
        grantedCapabilities: [...capabilities.grantedCapabilities],
        allowedArtifactRequestCapabilities: [...capabilities.allowedArtifactRequestCapabilities],
      },
    } as BoardSnapshotV2;
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
