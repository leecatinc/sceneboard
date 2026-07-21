import { Inject, Injectable } from '@nestjs/common';
import {
  BoardEventEnvelopeParserV1,
  type BoardId,
  type EventId,
  type PresenceSummaryV1,
  type TabId,
  type TimestampV1,
} from '@sceneboard/board-schema';

import { CryptoService } from '../common/security/crypto.service.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { RedisEventFanoutService } from '../events/redis-event-fanout.service.js';
import {
  RedisPresenceRepository,
  type RedisPresenceHandleV1,
} from '../presence/redis-presence.repository.js';
import { BoardStreamCutService } from './board-stream-cut.service.js';
import { SseResponseWriter } from './sse-response-writer.js';

export interface BoardSseRequestLifecycleV1 {
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

export interface BoardSseResponseV1 {
  statusCode: number;
  headersSent: boolean;
  httpVersionMajor?: number | undefined;
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
  flushHeaders?(): unknown;
  write(chunk: Uint8Array): boolean;
  once(event: 'drain', listener: () => void): unknown;
  off(event: 'drain', listener: () => void): unknown;
  end(): unknown;
}

@Injectable()
export class BoardSseService {
  constructor(
    @Inject(BoardStreamCutService) private readonly cuts: BoardStreamCutService,
    @Inject(RedisEventFanoutService) private readonly fanout: RedisEventFanoutService,
    @Inject(SseResponseWriter) private readonly writer: SseResponseWriter,
    @Inject(RedisPresenceRepository) private readonly presence: RedisPresenceRepository,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async stream(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    cursor: string | null;
    tabId: TabId;
    presenceState: 'online' | 'away';
    allowedOrigin: string;
    request: BoardSseRequestLifecycleV1;
    response: BoardSseResponseV1;
  }): Promise<void> {
    let cut = await this.cuts.prepare(input.principal, input.boardId, input.cursor);
    let sequence = cut.sequence;
    let durableDirty = false;
    let presenceDirty = false;
    let stopped = false;
    let lastAuthorizationAt = Date.now();
    let presenceHandle: RedisPresenceHandleV1 | null = null;
    let lastPresenceVersion = -1;
    let wakeResolver: (() => void) | null = null;
    const signalWake = (): void => {
      const resolve = wakeResolver;
      if (resolve !== null) resolve();
    };
    const wake = (hint: { kind: 'durable' | 'presence' }): void => {
      if (hint.kind === 'durable') durableDirty = true;
      else presenceDirty = true;
      signalWake();
    };
    const unsubscribe = await this.fanout.subscribeBoard(input.boardId, wake);
    const onRequestClose = (): void => {
      stopped = true;
      signalWake();
    };
    input.request.once('close', onRequestClose);

    const drain = async (): Promise<void> => {
      if (stopped) return;
      durableDirty = false;
      const head = await this.cuts.reauthorize(input.principal, input.boardId);
      lastAuthorizationAt = Date.now();
      if (head <= sequence) return;
      if (head - sequence > 1_000) throw new Error('SSE replay window exceeded');
      const frames = await this.cuts.rangeAfter(input.boardId, sequence, head);
      if (frames === null) throw new Error('SSE durable range gap');
      for (const frame of frames) {
        if (stopped) return;
        await this.writer.write(
          input.response,
          this.writer.encodeEvent(frame.canonicalBytes, frame.cursor),
        );
        sequence = frame.envelope.sequence;
      }
    };

    const writePresence = async (): Promise<void> => {
      presenceDirty = false;
      const aggregate = await this.presence.aggregate(input.boardId);
      if (aggregate.version === lastPresenceVersion) return;
      const occurredAt = new Date().toISOString() as TimestampV1;
      const parsed = BoardEventEnvelopeParserV1.parse({
        protocolVersion: 1,
        type: 'board.event',
        boardId: input.boardId,
        eventId: this.crypto.generatePublicIdV1() as EventId,
        sequence,
        occurredAt,
        revisionId: null,
        data: { type: 'presence.updated', presence: aggregate.presence as PresenceSummaryV1[] },
      });
      if (!parsed.ok) throw new Error('presence event composition failure');
      await this.writer.write(
        input.response,
        this.writer.encodeEvent(parsed.data.canonicalBytes, null),
      );
      lastPresenceVersion = aggregate.version;
    };

    try {
      const postCutHead = await this.cuts.reauthorize(input.principal, input.boardId);
      lastAuthorizationAt = Date.now();
      if (postCutHead > sequence) {
        const catchUp =
          postCutHead - sequence <= 1_000
            ? await this.cuts.rangeAfter(input.boardId, sequence, postCutHead)
            : null;
        if (catchUp === null) {
          cut = await this.cuts.prepare(input.principal, input.boardId, null);
        } else {
          cut = { frames: [...cut.frames, ...catchUp], sequence: postCutHead };
        }
        sequence = cut.sequence;
      }
      if (input.principal.kind !== 'user')
        throw new Error('browser presence requires a user principal');
      presenceHandle = await this.presence.open({
        boardId: input.boardId,
        ownerUserPk: input.principal.userPk,
        tabId: input.tabId,
        actor: input.principal.actor,
        state: input.presenceState,
      });
      if (stopped) return;

      input.response.statusCode = 200;
      input.response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      input.response.setHeader('Cache-Control', 'no-cache, no-store, private');
      input.response.setHeader('X-Accel-Buffering', 'no');
      input.response.setHeader('Vary', 'Origin, Cookie');
      input.response.setHeader('Access-Control-Allow-Origin', input.allowedOrigin);
      input.response.setHeader('Access-Control-Allow-Credentials', 'true');
      input.response.removeHeader('Content-Length');
      if (input.response.httpVersionMajor === 1)
        input.response.setHeader('Connection', 'keep-alive');
      input.response.flushHeaders?.();

      for (const frame of cut.frames) {
        if (stopped) break;
        await this.writer.write(
          input.response,
          this.writer.encodeEvent(frame.canonicalBytes, frame.cursor),
        );
        sequence = frame.envelope.sequence;
      }
      lastPresenceVersion = -1;
      presenceDirty = true;
      if (!stopped) await writePresence();
      if (durableDirty && !stopped) await drain();
      const startedAt = Date.now();
      let lastKeepaliveAt = startedAt;
      let lastPresencePollAt = startedAt;
      let lastPresenceTouchAt = startedAt;
      while (!stopped && Date.now() - startedAt < 30_000) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wakeResolver = null;
            resolve();
          };
          const timer = setTimeout(finish, 1_000);
          timer.unref();
          wakeResolver = finish;
          if (durableDirty || presenceDirty) finish();
        });
        if (stopped) break;
        const now = Date.now();
        if (durableDirty || now - lastAuthorizationAt >= 1_000) await drain();
        if (presenceDirty || now - lastPresencePollAt >= 5_000) {
          await writePresence();
          lastPresencePollAt = Date.now();
        }
        if (presenceHandle !== null && now - lastPresenceTouchAt >= 10_000) {
          if (!(await this.presence.touch(presenceHandle)))
            throw new Error('presence lease was lost');
          lastPresenceTouchAt = Date.now();
        }
        if (Date.now() - lastKeepaliveAt >= 10_000) {
          await this.writer.write(input.response, this.writer.encodeKeepalive());
          lastKeepaliveAt = Date.now();
        }
      }
    } finally {
      stopped = true;
      signalWake();
      input.request.off('close', onRequestClose);
      await unsubscribe();
      if (presenceHandle !== null) await this.presence.close(presenceHandle).catch(() => false);
      if (input.response.headersSent) input.response.end();
    }
  }
}
