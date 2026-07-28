'use client';

import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  ShareAnalyticsContextParserV1,
  ShareAnalyticsErrorEnvelopeParserV1,
  ShareAnalyticsEventParserV1,
  ShareAnalyticsEventResultParserV1,
  ShareAnalyticsReportParserV1,
  type ShareAnalyticsContextV1,
  type ShareAnalyticsEventV1,
  type ShareAnalyticsEventResultV1,
  type ShareAnalyticsReportV1,
} from '@sceneboard/board-schema';

import type { SessionRequestCoordinator } from '../auth/renewal-singleflight';

type Fetcher = typeof fetch;

export type PublicAnalyticsContextResultV1 =
  | Readonly<{ kind: 'ok'; value: ShareAnalyticsContextV1 }>
  | Readonly<{ kind: 'unavailable' }>;

export type PublicAnalyticsEventCompletionV1 =
  | Readonly<{ kind: 'complete'; value: ShareAnalyticsEventResultV1 }>
  | Readonly<{ kind: 'context_evicted' }>
  | Readonly<{ kind: 'discarded' }>;

const canonicalOrigin = (value: string): string => {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  )
    throw new TypeError('share analytics API origin is invalid');
  return parsed.origin;
};

const jsonOrNull = async (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

export const createShareAnalyticsIntentKeyV1 = (): string =>
  `view_${crypto.randomUUID().replaceAll('-', '')}`;

export const issuePublicShareAnalyticsContextV1 = async (input: {
  apiOrigin: string;
  shareId: string;
  signal?: AbortSignal;
  fetcher?: Fetcher;
}): Promise<PublicAnalyticsContextResultV1> => {
  const shareId = GlobalIdStringParserV1.parse(input.shareId);
  if (!shareId.ok) return { kind: 'unavailable' };
  try {
    const response = await (input.fetcher ?? fetch)(
      `${canonicalOrigin(input.apiOrigin)}/api/v1/public/shares/${encodeURIComponent(shareId.data.value)}/view-contexts`,
      {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    if (response.status !== 201) return { kind: 'unavailable' };
    const parsed = ShareAnalyticsContextParserV1.parse(await jsonOrNull(response));
    return parsed.ok ? { kind: 'ok', value: parsed.data.value } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
};

type EventAttempt =
  | Readonly<{ kind: 'complete'; value: ShareAnalyticsEventResultV1 }>
  | Readonly<{ kind: 'retry'; retryAfterMilliseconds: number }>
  | Readonly<{ kind: 'evict' }>
  | Readonly<{ kind: 'terminal' }>;

const retryAfterMilliseconds = (response: Response, fallback: number): number => {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(1_000, Math.max(fallback, Math.round(seconds * 1_000)))
    : fallback;
};

const sendEventAttempt = async (input: {
  apiOrigin: string;
  context: ShareAnalyticsContextV1;
  event: ShareAnalyticsEventV1;
  signal: AbortSignal;
  retryDelay: number;
  fetcher: Fetcher;
}): Promise<EventAttempt> => {
  const attemptController = new AbortController();
  const abortAttempt = () => attemptController.abort();
  input.signal.addEventListener('abort', abortAttempt, { once: true });
  const timeout = setTimeout(abortAttempt, 5_000);
  try {
    const response = await input.fetcher(
      `${canonicalOrigin(input.apiOrigin)}/api/v1/public/share-view-events`,
      {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'X-SceneBoard-View-CSRF': input.context.csrfToken,
        },
        body: JSON.stringify(input.event),
        signal: attemptController.signal,
      },
    );
    const body = await jsonOrNull(response);
    if (response.status === 200 || response.status === 202) {
      const parsed = ShareAnalyticsEventResultParserV1.parse(body);
      if (
        parsed.ok &&
        ((response.status === 202 && parsed.data.value.replayed === false) ||
          (response.status === 200 && parsed.data.value.replayed === true))
      )
        return { kind: 'complete', value: parsed.data.value };
      return { kind: 'terminal' };
    }
    if (response.status === 404) {
      const error = ShareAnalyticsErrorEnvelopeParserV1.parse(body);
      return error.ok && error.data.value.error.code === 'SHARE_VIEW_UNAVAILABLE'
        ? { kind: 'evict' }
        : { kind: 'terminal' };
    }
    if (response.status === 429 || response.status === 503)
      return {
        kind: 'retry',
        retryAfterMilliseconds: retryAfterMilliseconds(response, input.retryDelay),
      };
    return { kind: 'terminal' };
  } catch {
    return input.signal.aborted
      ? { kind: 'terminal' }
      : { kind: 'retry', retryAfterMilliseconds: input.retryDelay };
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener('abort', abortAttempt);
  }
};

const waitForRetry = (milliseconds: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });

export const dispatchPublicShareAnalyticsEventV1 = async (input: {
  apiOrigin: string;
  context: ShareAnalyticsContextV1;
  eventKind: ShareAnalyticsEventV1['eventKind'];
  pageId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  now?: () => number;
  fetcher?: Fetcher;
  retryWait?: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
}): Promise<PublicAnalyticsEventCompletionV1> => {
  const parsedEvent = ShareAnalyticsEventParserV1.parse({
    viewContextId: input.context.viewContextId,
    eventKind: input.eventKind,
    pageId: input.pageId,
    idempotencyKey: input.idempotencyKey,
  });
  if (!parsedEvent.ok) return { kind: 'discarded' };
  const expiry = Date.parse(input.context.expiresAt);
  const now = input.now ?? Date.now;
  const fetcher = input.fetcher ?? fetch;
  const retryWait = input.retryWait ?? waitForRetry;
  const delays = [250, 1_000] as const;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (input.signal.aborted || !input.isCurrent() || now() >= expiry) return { kind: 'discarded' };
    const result = await sendEventAttempt({
      apiOrigin: input.apiOrigin,
      context: input.context,
      event: parsedEvent.data.value,
      signal: input.signal,
      retryDelay: delays[Math.min(attempt, 1)]!,
      fetcher,
    });
    if (result.kind === 'complete') return result;
    if (result.kind === 'evict') return { kind: 'context_evicted' };
    if (result.kind === 'terminal' || attempt === 2) return { kind: 'discarded' };
    if (now() + result.retryAfterMilliseconds >= expiry) return { kind: 'discarded' };
    if (!(await retryWait(result.retryAfterMilliseconds, input.signal)))
      return { kind: 'discarded' };
  }
  return { kind: 'discarded' };
};

export type ShareAnalyticsReportResultV1 =
  | Readonly<{ kind: 'ok'; value: ShareAnalyticsReportV1 }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'unavailable' }>;

export class ShareAnalyticsApi {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  async report(
    boardIdValue: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<ShareAnalyticsReportResultV1> {
    const boardId = BoardIdParserV1.parse(boardIdValue);
    if (!boardId.ok) return { kind: 'not_found' };
    const query = new URLSearchParams({ from, to });
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(boardId.data.value)}/share-analytics?${query.toString()}`,
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return { kind: 'unavailable' };
    if (result.value.response.status === 404) return { kind: 'not_found' };
    if (result.value.response.status !== 200) return { kind: 'unavailable' };
    const parsed = ShareAnalyticsReportParserV1.parse(result.value.body);
    return parsed.ok ? { kind: 'ok', value: parsed.data.value } : { kind: 'unavailable' };
  }
}
