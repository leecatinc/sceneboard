import {
  BoardEventEnvelopeParserV1,
  type BoardEventEnvelopeV1,
  type BoardId,
  type EventId,
  type HitlInteractionV1,
  type TimestampV1,
} from '@leecat-board/board-schema';

import { internalHitlFailure } from './hitl-errors.js';

export const hitlUpdatedEvent = (input: {
  boardId: BoardId;
  eventId: EventId;
  sequence: number;
  occurredAt: TimestampV1;
  interaction: HitlInteractionV1;
}): BoardEventEnvelopeV1 => {
  const parsed = BoardEventEnvelopeParserV1.parse({
    protocolVersion: 1,
    type: 'board.event',
    boardId: input.boardId,
    eventId: input.eventId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    revisionId: null,
    data: { type: 'hitl.updated', hitl: input.interaction },
  });
  if (!parsed.ok) throw internalHitlFailure();
  return parsed.data.value;
};
