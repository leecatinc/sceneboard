import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { BoardId } from '@leecat-board/board-schema';

import { RedisStreamKeyspace } from '../redis/redis-stream-keyspace.js';
import { assertBoardIdV1, parseBoardEventHintV1, type BoardEventHintV1 } from './board-event-hint.js';
import {
  REDIS_EVENT_TRANSPORT_V1,
  type RedisEventTransportPortV1,
} from './ports/redis-event-transport.port.js';

type HintListener = (hint: BoardEventHintV1) => void;
type BoardSubscription = {
  boardFp: string;
  listeners: Set<HintListener>;
  unsubscribe: () => Promise<void>;
};

@Injectable()
export class RedisEventFanoutService implements OnModuleDestroy {
  readonly #subscriptions = new Map<BoardId, BoardSubscription>();

  constructor(
    @Inject(REDIS_EVENT_TRANSPORT_V1) private readonly redis: RedisEventTransportPortV1,
    private readonly keyspace: RedisStreamKeyspace,
  ) {}

  async subscribeBoard(boardIdInput: BoardId, listener: HintListener): Promise<() => Promise<void>> {
    const boardId = assertBoardIdV1(boardIdInput);
    let subscription = this.#subscriptions.get(boardId);
    if (subscription === undefined) {
      const boardFp = this.keyspace.boardFingerprint(boardId);
      const listeners = new Set<HintListener>();
      const unsubscribe = await this.redis.subscribe(this.keyspace.boardHintChannel(boardId), (message) => {
        const hint = parseBoardEventHintV1(message, boardFp);
        if (hint === null) return;
        for (const current of listeners) current(hint);
      });
      subscription = { boardFp, listeners, unsubscribe };
      this.#subscriptions.set(boardId, subscription);
    }
    subscription.listeners.add(listener);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.#subscriptions.get(boardId);
      current?.listeners.delete(listener);
      if (current?.listeners.size === 0) {
        this.#subscriptions.delete(boardId);
        await current.unsubscribe();
      }
    };
  }

  async onModuleDestroy(): Promise<void> {
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()));
  }
}
