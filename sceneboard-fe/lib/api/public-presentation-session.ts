import {
  PublicPresentationEndResultSchemaV1,
  PublicPresentationEventSchemaV1,
  PublicPresentationSessionListSchemaV1,
  PublicPresentationSnapshotSchemaV1,
  type PublicPresentationSessionListV1,
  type PublicPresentationSnapshotV1,
  type PublicPresentationUpdateRequestV1,
} from '@sceneboard/board-schema';

export class PublicPresentationApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`public presentation request failed with ${status}`);
    this.name = 'PublicPresentationApiError';
  }
}

const route = (apiOrigin: string, contextId: string, suffix = ''): string =>
  new URL(
    `/api/v1/public/share-contexts/${encodeURIComponent(contextId)}/presentation-sessions${suffix}`,
    apiOrigin,
  ).toString();

const request = async <Value>(input: {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  parse: (value: unknown) => Value | null;
}): Promise<Value> => {
  const response = await fetch(input.url, {
    method: input.method ?? 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    ...(input.body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.body) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After');
    throw new PublicPresentationApiError(
      response.status,
      retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : null,
    );
  }
  const value: unknown = await response.json();
  const parsed = input.parse(value);
  if (parsed === null) throw new PublicPresentationApiError(503);
  return parsed;
};

const snapshot = (value: unknown): PublicPresentationSnapshotV1 | null => {
  const parsed = PublicPresentationSnapshotSchemaV1.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const listPublicPresentationSessionsV1 = (input: {
  apiOrigin: string;
  contextId: string;
  signal?: AbortSignal;
}): Promise<PublicPresentationSessionListV1> =>
  request({
    url: route(input.apiOrigin, input.contextId),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    parse: (value) => {
      const parsed = PublicPresentationSessionListSchemaV1.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  });

export const startPublicPresentationSessionV1 = (input: {
  apiOrigin: string;
  contextId: string;
  currentPageId: string;
  signal?: AbortSignal;
}): Promise<PublicPresentationSnapshotV1> =>
  request({
    url: route(input.apiOrigin, input.contextId),
    method: 'POST',
    body: { currentPageId: input.currentPageId },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    parse: snapshot,
  });

export const getPublicPresentationSessionV1 = (input: {
  apiOrigin: string;
  contextId: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<PublicPresentationSnapshotV1> =>
  request({
    url: route(input.apiOrigin, input.contextId, `/${encodeURIComponent(input.sessionId)}`),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    parse: snapshot,
  });

export const updatePublicPresentationSessionV1 = (input: {
  apiOrigin: string;
  contextId: string;
  sessionId: string;
  update: PublicPresentationUpdateRequestV1;
  signal?: AbortSignal;
}): Promise<PublicPresentationSnapshotV1> =>
  request({
    url: route(input.apiOrigin, input.contextId, `/${encodeURIComponent(input.sessionId)}/state`),
    method: 'POST',
    body: input.update,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    parse: snapshot,
  });

export const endPublicPresentationSessionV1 = async (input: {
  apiOrigin: string;
  contextId: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<void> => {
  await request({
    url: route(input.apiOrigin, input.contextId, `/${encodeURIComponent(input.sessionId)}/end`),
    method: 'POST',
    body: {},
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    parse: (value) => {
      const parsed = PublicPresentationEndResultSchemaV1.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  });
};

export const publicPresentationEventsUrlV1 = (input: {
  apiOrigin: string;
  contextId: string;
  sessionId: string;
}): string =>
  route(input.apiOrigin, input.contextId, `/${encodeURIComponent(input.sessionId)}/events`);

export const parsePublicPresentationEventV1 = (
  source: string,
): PublicPresentationSnapshotV1 | null => {
  try {
    const parsed = PublicPresentationEventSchemaV1.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data.snapshot : null;
  } catch {
    return null;
  }
};
