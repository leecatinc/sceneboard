import type { BoardId } from '@sceneboard/board-schema';

import type { AuthorizedBoardContextV1 } from '../../grants/board-access.policy.js';

declare const authorizedBrowserPresenceSubjectBrand: unique symbol;

export type AuthorizedBrowserPresenceSubjectV1 = {
  readonly [authorizedBrowserPresenceSubjectBrand]: true;
};

export const AUTHORIZED_BROWSER_PRESENCE_PORT_V1 = Symbol('AUTHORIZED_BROWSER_PRESENCE_PORT_V1');

export interface AuthorizedBrowserPresencePortV1 {
  captureAuthorizedSubject(
    context: AuthorizedBoardContextV1,
    boardId: BoardId,
  ): AuthorizedBrowserPresenceSubjectV1 | null;

  getStatus(subject: AuthorizedBrowserPresenceSubjectV1): Promise<'online' | 'offline' | 'unknown'>;
}
