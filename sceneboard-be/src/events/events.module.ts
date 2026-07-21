import { Module } from '@nestjs/common';

import { RedisService } from '../redis/redis.service.js';
import { BoardEventOutboxRepository } from './board-event-outbox.repository.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';
import {
  BOARD_EVENT_DELIVERY_PORT_V1,
  BOARD_EVENT_OUTBOX_HEALTH_PORT_V1,
} from './ports/board-event-delivery.tokens.js';
import { REDIS_EVENT_TRANSPORT_V1 } from './ports/redis-event-transport.port.js';
import { RedisEventFanoutService } from './redis-event-fanout.service.js';

@Module({
  providers: [
    BoardEventOutboxRepository,
    { provide: BOARD_EVENT_DELIVERY_PORT_V1, useExisting: BoardEventOutboxRepository },
    { provide: BOARD_EVENT_OUTBOX_HEALTH_PORT_V1, useExisting: BoardEventOutboxRepository },
    { provide: REDIS_EVENT_TRANSPORT_V1, useExisting: RedisService },
    OutboxDispatcherService,
    RedisEventFanoutService,
  ],
  exports: [
    BOARD_EVENT_DELIVERY_PORT_V1,
    BOARD_EVENT_OUTBOX_HEALTH_PORT_V1,
    OutboxDispatcherService,
    RedisEventFanoutService,
  ],
})
export class EventsModule {}
