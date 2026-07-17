import type {
  BoardEventEnvelopeV1,
  BoardId,
  EventId,
  RevisionId,
} from '@leecat-board/board-schema';

export type PendingBoardEventCandidateV1 = { eventPk: bigint; eventId: EventId };

export type DeliverableBoardEventV1 = {
  eventPk: bigint;
  eventId: EventId;
  boardId: BoardId;
  revisionId: RevisionId | null;
  sequence: number;
  eventType: BoardEventEnvelopeV1['data']['type'];
  envelope: BoardEventEnvelopeV1;
  canonicalBytes: Uint8Array;
};

export type BoardEventHeadV1 = {
  boardId: BoardId;
  lastEventSequence: number;
  headRevisionId: RevisionId;
};

export interface BoardEventDeliveryPortV1 {
  listPendingCandidates(limit?: number): Promise<readonly PendingBoardEventCandidateV1[]>;
  loadPendingEvent(candidate: PendingBoardEventCandidateV1): Promise<DeliverableBoardEventV1 | null>;
  markDelivered(eventPk: bigint): Promise<boolean>;
  getHead(boardId: BoardId): Promise<BoardEventHeadV1 | null>;
  getEvent(boardId: BoardId, sequence: number): Promise<DeliverableBoardEventV1 | null>;
  listContiguousEvents(boardId: BoardId, afterSequence: number, limit?: number): Promise<readonly DeliverableBoardEventV1[]>;
}
