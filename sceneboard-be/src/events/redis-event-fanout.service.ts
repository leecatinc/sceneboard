import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { BoardId } from '@sceneboard/board-schema';

import { RedisStreamKeyspace } from '../redis/redis-stream-keyspace.js';
import {
  assertBoardIdV1,
  parseBoardEventHintV1,
  type BoardEventHintV1,
} from './board-event-hint.js';
import {
  REDIS_EVENT_TRANSPORT_V1,
  type RedisEventTransportPortV1,
} from './ports/redis-event-transport.port.js';

type HintListener = (hint: BoardEventHintV1) => void;
type BoardSubscription = {
  boardFp: string;
  listeners: Set<HintListener>;
  setup: Promise<void>;
  transportUnsubscribe: (() => Promise<void>) | null;
  teardown: Promise<void> | null;
  closed: boolean;
};

@Injectable()
export class RedisEventFanoutService implements OnModuleDestroy {
  readonly #subscriptions = new Map<BoardId, BoardSubscription>();

  constructor(
    @Inject(REDIS_EVENT_TRANSPORT_V1) private readonly redis: RedisEventTransportPortV1,
    @Inject(RedisStreamKeyspace) private readonly keyspace: RedisStreamKeyspace,
  ) {}

  async subscribeBoard(
    boardIdInput: BoardId,
    listener: HintListener,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    const boardId = assertBoardIdV1(boardIdInput);
    let subscription = this.#subscriptions.get(boardId);
    if (subscription === undefined) {
      const boardFp = this.keyspace.boardFingerprint(boardId);
      const listeners = new Set<HintListener>();
      subscription = {
        boardFp,
        listeners,
        setup: Promise.resolve(),
        transportUnsubscribe: null,
        teardown: null,
        closed: false,
      };
      this.#subscriptions.set(boardId, subscription);
      const ownedSubscription = subscription;
      ownedSubscription.setup = Promise.resolve()
        .then(() =>
          this.redis.subscribe(this.keyspace.boardHintChannel(boardId), (message) => {
            if (ownedSubscription.closed) return;
            const hint = parseBoardEventHintV1(message, boardFp);
            if (hint === null) return;
            for (const current of listeners) {
              try {
                current(hint);
              } catch {
                // One request listener must not prevent delivery to the remaining listeners.
              }
            }
          }),
        )
        .then(async (unsubscribe) => {
          ownedSubscription.transportUnsubscribe = unsubscribe;
          if (!ownedSubscription.closed) return;
          const teardown = Promise.resolve().then(unsubscribe);
          ownedSubscription.teardown = teardown;
          await teardown;
        })
        .catch((error: unknown) => {
          if (this.#subscriptions.get(boardId) === ownedSubscription)
            this.#subscriptions.delete(boardId);
          ownedSubscription.closed = true;
          ownedSubscription.listeners.clear();
          throw error;
        });
    }
    subscription.listeners.add(listener);
    let active = true;
    const remove = async (): Promise<void> => {
      if (!active) return;
      active = false;
      signal?.removeEventListener('abort', cancelPending);
      subscription.listeners.delete(listener);
      if (subscription.listeners.size === 0) await this.#close(boardId, subscription);
    };
    const cancelPending = (): void => {
      void remove().catch(() => undefined);
    };
    signal?.addEventListener('abort', cancelPending, { once: true });
    if (signal?.aborted) cancelPending();
    try {
      await subscription.setup;
    } catch (error) {
      active = false;
      signal?.removeEventListener('abort', cancelPending);
      subscription.listeners.delete(listener);
      throw error;
    }
    if (subscription.closed || !subscription.listeners.has(listener)) {
      active = false;
      signal?.removeEventListener('abort', cancelPending);
      throw new Error('fanout subscription closed during setup');
    }
    return remove;
  }

  async onModuleDestroy(): Promise<void> {
    const subscriptions = [...this.#subscriptions.entries()];
    this.#subscriptions.clear();
    await Promise.allSettled(
      subscriptions.map(([boardId, subscription]) => this.#close(boardId, subscription)),
    );
  }

  #close(boardId: BoardId, subscription: BoardSubscription): Promise<void> {
    subscription.closed = true;
    subscription.listeners.clear();
    if (this.#subscriptions.get(boardId) === subscription) this.#subscriptions.delete(boardId);
    if (subscription.teardown !== null) return subscription.teardown;
    if (subscription.transportUnsubscribe === null) return subscription.setup;
    subscription.teardown = Promise.resolve().then(subscription.transportUnsubscribe);
    return subscription.teardown;
  }
}
