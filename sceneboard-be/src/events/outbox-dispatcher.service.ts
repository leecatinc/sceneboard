import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { RedisStreamKeyspace } from '../redis/redis-stream-keyspace.js';
import { encodeDurableBoardEventHintV1 } from './board-event-hint.js';
import type { BoardEventDeliveryPortV1 } from './ports/board-event-delivery.port.js';
import { BOARD_EVENT_DELIVERY_PORT_V1 } from './ports/board-event-delivery.tokens.js';
import {
  REDIS_EVENT_TRANSPORT_V1,
  type RedisEventTransportPortV1,
} from './ports/redis-event-transport.port.js';

export type OutboxDispatchRunV1 = {
  candidates: number;
  leaseWins: number;
  published: number;
  markedDelivered: number;
  failures: number;
};

@Injectable()
export class OutboxDispatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #logger = new Logger(OutboxDispatcherService.name);
  #stopping = false;
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<void> | null = null;
  #emptyDelayMs = 250;

  constructor(
    @Inject(BOARD_EVENT_DELIVERY_PORT_V1) private readonly delivery: BoardEventDeliveryPortV1,
    @Inject(REDIS_EVENT_TRANSPORT_V1) private readonly redis: RedisEventTransportPortV1,
    @Inject(RedisStreamKeyspace) private readonly keyspace: RedisStreamKeyspace,
  ) {}

  onApplicationBootstrap(): void {
    this.#schedule(250);
  }

  async onModuleDestroy(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    await this.#active;
  }

  async dispatchOnce(): Promise<OutboxDispatchRunV1> {
    const result: OutboxDispatchRunV1 = {
      candidates: 0,
      leaseWins: 0,
      published: 0,
      markedDelivered: 0,
      failures: 0,
    };
    const candidates = await this.delivery.listPendingCandidates(100);
    result.candidates = candidates.length;
    for (const candidate of candidates) {
      if (this.#stopping) break;
      try {
        const won = await this.redis.tryAcquireLease(
          this.keyspace.eventLeaseKey(candidate.eventId),
          10_000,
        );
        if (!won) continue;
        result.leaseWins += 1;
        const event = await this.delivery.loadPendingEvent(candidate);
        if (event === null) continue;
        const boardFp = this.keyspace.boardFingerprint(event.boardId);
        const hint = encodeDurableBoardEventHintV1(boardFp, event.eventId, event.sequence);
        await this.redis.publish(this.keyspace.boardHintChannel(event.boardId), hint);
        result.published += 1;
        if (await this.delivery.markDelivered(event.eventPk)) result.markedDelivered += 1;
      } catch {
        result.failures += 1;
        this.#logger.error('outbox event dispatch failed');
      }
    }
    return result;
  }

  #schedule(delayMs: number): void {
    if (this.#stopping) return;
    this.#timer = setTimeout(() => {
      this.#active = this.#runLoop();
    }, delayMs);
    this.#timer.unref();
  }

  async #runLoop(): Promise<void> {
    try {
      const result = await this.dispatchOnce();
      this.#emptyDelayMs = result.candidates === 0 ? Math.min(this.#emptyDelayMs * 2, 2_000) : 250;
    } catch {
      this.#emptyDelayMs = Math.min(this.#emptyDelayMs * 2, 2_000);
      this.#logger.error('outbox candidate poll failed');
    } finally {
      this.#active = null;
      this.#schedule(this.#emptyDelayMs);
    }
  }
}
