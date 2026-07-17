export const BOARD_STREAM_OPERATIONAL_HEALTH_PORT_V1 = Symbol('BOARD_STREAM_OPERATIONAL_HEALTH_PORT_V1');

export type BoardStreamOperationalHealthV1 = {
  live: true;
  ready: boolean;
  replayAvailable: boolean;
  redisCommandReady: boolean;
  redisSubscriberReady: boolean;
  oldestPendingAgeMs: number;
  quarantinedCorruptPending: boolean;
};

export interface BoardStreamOperationalHealthPortV1 {
  getOperationalHealth(): BoardStreamOperationalHealthV1;
}
