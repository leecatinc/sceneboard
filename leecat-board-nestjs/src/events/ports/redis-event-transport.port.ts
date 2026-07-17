export const REDIS_EVENT_TRANSPORT_V1 = Symbol('REDIS_EVENT_TRANSPORT_V1');

export interface RedisEventTransportPortV1 {
  tryAcquireLease(key: string, ttlMs: number): Promise<boolean>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>>;
}
