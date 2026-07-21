export type BoardEventOutboxHealthV1 = {
  oldestPendingAgeMs: number;
  quarantinedCorruptPending: boolean;
};

export interface BoardEventOutboxHealthPortV1 {
  getHealth(): Promise<BoardEventOutboxHealthV1>;
}
