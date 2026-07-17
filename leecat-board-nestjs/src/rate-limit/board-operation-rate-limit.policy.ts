export const BoardOperationRateLimitPolicy = {
  'board-read': { pre: [1_000, 300_000], post: [600, 300_000] },
  'capability-negotiation': { pre: [300, 300_000], post: [120, 300_000] },
  'board-mutation': { pre: [1_000, 300_000], post: [120, 300_000] },
  'board-create': { pre: [300, 3_600_000], post: [20, 3_600_000] },
  'board-archive': { pre: [300, 3_600_000], post: [30, 3_600_000] },
} as const;

export type BoardOperationRateLimitClass = keyof typeof BoardOperationRateLimitPolicy;
