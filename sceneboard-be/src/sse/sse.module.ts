import { Module } from '@nestjs/common';

import { BoardModule } from '../boards/board.module.js';
import { EventsModule } from '../events/events.module.js';
import { BoardSseController } from './board-sse.controller.js';
import { BoardSseService } from './board-sse.service.js';
import { BoardStreamCutService } from './board-stream-cut.service.js';
import { SseCursorCodec } from './sse-cursor.codec.js';
import { SseResponseWriter } from './sse-response-writer.js';
import { PresenceModule } from '../presence/presence.module.js';
import { BoardStreamHealthService } from './board-stream-health.service.js';
import { BOARD_STREAM_OPERATIONAL_HEALTH_PORT_V1 } from './ports/board-stream-operational-health.port.js';

@Module({
  imports: [BoardModule, EventsModule, PresenceModule],
  controllers: [BoardSseController],
  providers: [
    SseCursorCodec,
    SseResponseWriter,
    BoardStreamCutService,
    BoardSseService,
    BoardStreamHealthService,
    { provide: BOARD_STREAM_OPERATIONAL_HEALTH_PORT_V1, useExisting: BoardStreamHealthService },
  ],
  exports: [SseCursorCodec, BoardStreamCutService, BOARD_STREAM_OPERATIONAL_HEALTH_PORT_V1],
})
export class SseModule {}
