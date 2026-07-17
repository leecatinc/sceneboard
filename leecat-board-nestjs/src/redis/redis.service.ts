import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import type { RedisRateLimitPort } from '../rate-limit/rate-limit.service.js';

@Injectable()
export class RedisService implements RedisRateLimitPort, OnModuleDestroy {
  private readonly command: Redis;
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Map<string, Set<(message: string) => void>>();

  constructor(@Inject(APP_ENVIRONMENT) environment: Pick<AppEnvironment, 'redis'>) {
    const options = {
      host: environment.redis.host,
      port: environment.redis.port,
      password: environment.redis.password,
      db: environment.redis.database,
      keyPrefix: '',
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3_000,
      commandTimeout: 3_000,
      showFriendlyErrorStack: false,
    } as const;
    this.command = new Redis(options);
    this.publisher = new Redis(options);
    this.subscriber = new Redis(options);
    for (const client of [this.command, this.publisher, this.subscriber]) {
      client.on('error', () => undefined);
    }
    this.subscriber.on('message', (channel, message) => {
      for (const listener of this.listeners.get(channel) ?? []) listener(message);
    });
  }

  async consume(script: string, key: string, args: readonly string[]): Promise<readonly [number, number]> {
    await this.#connect(this.command);
    const result = await this.command.eval(script, 1, key, ...args);
    if (!Array.isArray(result) || result.length !== 2) throw new Error('Redis limiter returned an invalid result');
    const count = Number(result[0]);
    const ttl = Number(result[1]);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ttl)) throw new Error('Redis limiter returned invalid numbers');
    return [count, ttl];
  }

  async tryAcquireLease(key: string, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) throw new TypeError('lease TTL is invalid');
    await this.#connect(this.command);
    return await this.command.set(key, '1', 'PX', ttlMs, 'NX') === 'OK';
  }

  async publish(channel: string, message: string): Promise<number> {
    await this.#connect(this.publisher);
    return this.publisher.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> {
    let channelListeners = this.listeners.get(channel);
    if (channelListeners === undefined) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
      await this.#connect(this.subscriber);
      await this.subscriber.subscribe(channel);
    }
    channelListeners.add(listener);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(channel);
      current?.delete(listener);
      if (current?.size === 0) {
        this.listeners.delete(channel);
        if (this.subscriber.status !== 'wait' && this.subscriber.status !== 'end') {
          await this.subscriber.unsubscribe(channel);
        }
      }
    };
  }

  async pingCommand(): Promise<boolean> {
    await this.#connect(this.command);
    return await this.command.ping() === 'PONG';
  }

  async evaluate(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
    if (keys.length > 16) throw new TypeError('too many Redis script keys');
    await this.#connect(this.command);
    return this.command.eval(script, keys.length, ...keys, ...args);
  }

  subscriberReady(): boolean {
    return this.subscriber.status === 'ready';
  }

  async ensureSubscriberReady(): Promise<boolean> {
    await this.#connect(this.subscriber);
    return this.subscriber.status === 'ready';
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    for (const client of [this.subscriber, this.publisher, this.command]) {
      if (client.status === 'wait' || client.status === 'end') continue;
      try {
        await client.quit();
      } catch {
        client.disconnect(false);
      }
    }
  }

  async #connect(client: Redis): Promise<void> {
    if (client.status === 'wait') await client.connect();
    if (client.status === 'end') throw new Error('Redis client is closed');
  }
}
