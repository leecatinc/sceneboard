export type PublicShareFailureStatus = 400 | 404 | 405 | 409 | 416 | 429 | 503;

export class PublicShareHttpError extends Error {
  constructor(
    readonly status: PublicShareFailureStatus,
    readonly retryAfterSeconds: number | null = status === 503 ? 1 : null,
    readonly contentRangeLength: number | null = null,
  ) {
    super(`public share request failed with ${status}`);
    this.name = 'PublicShareHttpError';
  }
}
