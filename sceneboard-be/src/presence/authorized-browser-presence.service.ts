import { Inject, Injectable } from '@nestjs/common';
import { BoardIdParserV1, type BoardId } from '@sceneboard/board-schema';

import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';
import {
  type AuthorizedBrowserPresencePortV1,
  type AuthorizedBrowserPresenceSubjectV1,
} from './ports/authorized-browser-presence.port.js';

export const BROWSER_PRESENCE_STATUS_READER_V1 = Symbol('BROWSER_PRESENCE_STATUS_READER_V1');

export interface BrowserPresenceStatusReaderV1 {
  getStatus(input: {
    boardId: BoardId;
    ownerUserPk: bigint;
  }): Promise<'online' | 'offline' | 'unknown'>;
}

type SealedSubject = {
  boardId: BoardId;
  ownerUserPk: bigint;
  generation: number;
};

@Injectable()
export class AuthorizedBrowserPresenceService implements AuthorizedBrowserPresencePortV1 {
  readonly #subjects = new WeakMap<object, SealedSubject>();
  readonly #consumed = new WeakSet<object>();
  #generation = 0;

  constructor(
    @Inject(BROWSER_PRESENCE_STATUS_READER_V1)
    private readonly reader: BrowserPresenceStatusReaderV1,
  ) {}

  captureAuthorizedSubject(
    context: AuthorizedBoardContextV1,
    boardId: BoardId,
  ): AuthorizedBrowserPresenceSubjectV1 | null {
    const parsed = BoardIdParserV1.parse(boardId);
    if (
      !parsed.ok ||
      context.ownerUserPk < 1n ||
      (context.access.kind === 'owner' && context.access.ownerUserPk !== context.ownerUserPk)
    )
      return null;
    if (this.#generation >= Number.MAX_SAFE_INTEGER) return null;
    this.#generation += 1;
    const subject = Object.freeze(Object.create(null) as object);
    this.#subjects.set(subject, {
      boardId: parsed.data.value,
      ownerUserPk: context.ownerUserPk,
      generation: this.#generation,
    });
    return subject as AuthorizedBrowserPresenceSubjectV1;
  }

  async getStatus(
    subject: AuthorizedBrowserPresenceSubjectV1,
  ): Promise<'online' | 'offline' | 'unknown'> {
    if (subject === null || typeof subject !== 'object' || this.#consumed.has(subject))
      return 'unknown';
    const sealed = this.#subjects.get(subject);
    if (sealed === undefined || !Number.isSafeInteger(sealed.generation)) return 'unknown';
    this.#consumed.add(subject);
    this.#subjects.delete(subject);
    try {
      const status = await this.reader.getStatus({
        boardId: sealed.boardId,
        ownerUserPk: sealed.ownerUserPk,
      });
      return status === 'online' || status === 'offline' ? status : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

@Injectable()
export class UnknownBrowserPresenceStatusReader implements BrowserPresenceStatusReaderV1 {
  async getStatus(): Promise<'unknown'> {
    return 'unknown';
  }
}
