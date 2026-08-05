'use client';

import {
  PublicPresentationEndResultSchemaV1,
  PublicPresentationEventSchemaV1,
  PublicPresentationSessionListSchemaV1,
  PublicPresentationSnapshotSchemaV1,
  type PublicPresentationSessionListV1,
  type PublicPresentationSnapshotV1,
  type PublicPresentationUpdateRequestV1,
} from '@sceneboard/board-schema';

import type { SessionRequestCoordinator } from '../auth/renewal-singleflight';

export class OwnerPresentationApiError extends Error {
  constructor(readonly status: number) {
    super(`owner presentation request failed with ${status}`);
    this.name = 'OwnerPresentationApiError';
  }
}

const route = (apiOrigin: string, boardId: string, revisionId: string, suffix = ''): string => {
  const url = new URL(
    `/api/v1/boards/${encodeURIComponent(boardId)}/presentation-sessions${suffix}`,
    apiOrigin,
  );
  url.searchParams.set('revisionId', revisionId);
  return url.toString();
};

export class OwnerPresentationSessionApi {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  list(input: {
    apiOrigin: string;
    boardId: string;
    revisionId: string;
  }): Promise<PublicPresentationSessionListV1> {
    return this.request({
      ...input,
      method: 'GET',
      body: undefined,
      parse: (value) => {
        const parsed = PublicPresentationSessionListSchemaV1.safeParse(value);
        return parsed.success ? parsed.data : null;
      },
    });
  }

  start(input: {
    apiOrigin: string;
    boardId: string;
    revisionId: string;
    currentPageId: string;
  }): Promise<PublicPresentationSnapshotV1> {
    return this.request({
      ...input,
      method: 'POST',
      body: { currentPageId: input.currentPageId },
      parse: this.snapshot,
    });
  }

  get(input: {
    apiOrigin: string;
    boardId: string;
    revisionId: string;
    sessionId: string;
  }): Promise<PublicPresentationSnapshotV1> {
    return this.request({
      ...input,
      suffix: `/${encodeURIComponent(input.sessionId)}`,
      method: 'GET',
      body: undefined,
      parse: this.snapshot,
    });
  }

  update(input: {
    apiOrigin: string;
    boardId: string;
    revisionId: string;
    sessionId: string;
    update: PublicPresentationUpdateRequestV1;
  }): Promise<PublicPresentationSnapshotV1> {
    return this.request({
      ...input,
      suffix: `/${encodeURIComponent(input.sessionId)}/state`,
      method: 'POST',
      body: input.update,
      parse: this.snapshot,
    });
  }

  async end(input: {
    apiOrigin: string;
    boardId: string;
    revisionId: string;
    sessionId: string;
  }): Promise<void> {
    await this.request({
      ...input,
      suffix: `/${encodeURIComponent(input.sessionId)}/end`,
      method: 'POST',
      body: {},
      parse: (value) => {
        const parsed = PublicPresentationEndResultSchemaV1.safeParse(value);
        return parsed.success ? parsed.data : null;
      },
    });
  }

  eventsUrl(input: {
    apiOrigin: string;
    boardId: string;
    revisionId: string;
    sessionId: string;
  }): string {
    return route(
      input.apiOrigin,
      input.boardId,
      input.revisionId,
      `/${encodeURIComponent(input.sessionId)}/events`,
    );
  }

  parseEvent(source: string): PublicPresentationSnapshotV1 | null {
    try {
      const parsed = PublicPresentationEventSchemaV1.safeParse(JSON.parse(source));
      return parsed.success ? parsed.data.snapshot : null;
    } catch {
      return null;
    }
  }

  private readonly snapshot = (value: unknown): PublicPresentationSnapshotV1 | null => {
    const parsed = PublicPresentationSnapshotSchemaV1.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  private async request<Value>(input: {
    apiOrigin: string;
    boardId: string;
    revisionId: string;
    suffix?: string;
    method: 'GET' | 'POST';
    body: unknown;
    parse: (value: unknown) => Value | null;
  }): Promise<Value> {
    const csrfToken =
      input.method === 'POST' ? this.coordinator.currentSnapshot()?.csrfToken : undefined;
    if (input.method === 'POST' && csrfToken === undefined)
      throw new OwnerPresentationApiError(401);
    const url = route(input.apiOrigin, input.boardId, input.revisionId, input.suffix ?? '');
    const relative = `${new URL(url).pathname}${new URL(url).search}`;
    const result = await this.coordinator.dispatchShared({
      path: relative,
      method: input.method,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(csrfToken === undefined ? {} : { csrfToken }),
    });
    if (result.kind !== 'ok') throw new OwnerPresentationApiError(401);
    if (!result.value.response.ok)
      throw new OwnerPresentationApiError(result.value.response.status);
    const parsed = input.parse(result.value.body);
    if (parsed === null) throw new OwnerPresentationApiError(503);
    return parsed;
  }
}
