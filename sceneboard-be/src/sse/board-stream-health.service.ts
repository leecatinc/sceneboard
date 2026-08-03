import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import type { BoardEventOutboxHealthPortV1 } from '../events/ports/board-event-outbox-health.port.js';
import { BOARD_EVENT_OUTBOX_HEALTH_PORT_V1 } from '../events/ports/board-event-delivery.tokens.js';
import { RedisService } from '../redis/redis.service.js';
import type {
  BoardStreamOperationalHealthPortV1,
  BoardStreamOperationalHealthV1,
} from './ports/board-stream-operational-health.port.js';
import { dispatchBackendSecretSinkV1 } from '../common/security/secret-sink-observability.js';

const INITIAL: BoardStreamOperationalHealthV1 = Object.freeze({
  live: true,
  ready: false,
  replayAvailable: false,
  redisCommandReady: false,
  redisSubscriberReady: false,
  oldestPendingAgeMs: 0,
  quarantinedCorruptPending: false,
});

@Injectable()
export class BoardStreamHealthService
  implements BoardStreamOperationalHealthPortV1, OnApplicationBootstrap, OnModuleDestroy
{
  #health = INITIAL;
  #degradeSamples = 0;
  #recoverSamples = 0;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #lastMetricRecord = '';

  constructor(
    @Inject(BOARD_EVENT_OUTBOX_HEALTH_PORT_V1)
    private readonly outbox: BoardEventOutboxHealthPortV1,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    this.#schedule();
  }

  onModuleDestroy(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
  }

  getOperationalHealth(): BoardStreamOperationalHealthV1 {
    return this.#health;
  }

  async sampleOnce(): Promise<BoardStreamOperationalHealthV1> {
    try {
      const [commandReady, subscriberReady, outbox] = await Promise.all([
        this.redis.pingCommand(),
        this.redis.ensureSubscriberReady(),
        this.outbox.getHealth(),
      ]);
      const dependenciesHealthy =
        commandReady && subscriberReady && !outbox.quarantinedCorruptPending;
      let ready = this.#health.ready;
      if (!dependenciesHealthy) {
        ready = false;
        this.#degradeSamples = 0;
        this.#recoverSamples = 0;
      } else if (outbox.oldestPendingAgeMs >= 10_000) {
        this.#degradeSamples += 1;
        this.#recoverSamples = 0;
        if (this.#degradeSamples >= 2) ready = false;
      } else if (outbox.oldestPendingAgeMs <= 5_000) {
        this.#recoverSamples += 1;
        this.#degradeSamples = 0;
        if (this.#recoverSamples >= 3) ready = true;
      } else {
        this.#degradeSamples = 0;
        this.#recoverSamples = 0;
      }
      this.#health = Object.freeze({
        live: true,
        ready,
        replayAvailable: true,
        redisCommandReady: commandReady,
        redisSubscriberReady: subscriberReady,
        oldestPendingAgeMs: outbox.oldestPendingAgeMs,
        quarantinedCorruptPending: outbox.quarantinedCorruptPending,
      });
    } catch {
      this.#degradeSamples = 0;
      this.#recoverSamples = 0;
      this.#health = Object.freeze({
        ...this.#health,
        live: true,
        ready: false,
        replayAvailable: false,
        redisCommandReady: false,
        redisSubscriberReady: false,
      });
    }
    dispatchBackendSecretSinkV1({
      sink: 'METRIC',
      rawPayload: this.#health,
      observer: { observe: (record) => (this.#lastMetricRecord = record) },
    });
    return this.#health;
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.sampleOnce().finally(() => this.#schedule());
    }, 5_000);
    this.#timer.unref();
  }
}
