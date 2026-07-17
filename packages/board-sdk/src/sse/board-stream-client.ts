import { BoardIdParserV1 } from '@leecat-board/board-schema';

import { createBoardEventReconcilerV1 } from '../events/index.js';
import { plannedRecycleJitterMsV1, reconnectBackoffMsV1 } from './reconnect-backoff.js';
import { createSseFrameParserV1, SseProtocolErrorV1 } from './sse-frame-parser.js';
import type {
  BoardStreamClientOptionsV1,
  BoardStreamClientV1,
  BoardStreamFailureV1,
  BoardStreamPresenceStateV1,
  BoardStreamRunResultV1,
  BoardStreamStateV1,
} from './board-stream.types.js';

const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SILENCE_TIMEOUT_MS = 25_000;
const PLANNED_INTENT_MS = 29_000;

type StopReason = Extract<BoardStreamRunResultV1, { kind: 'stopped' }>['reason'];
type ReconnectReason = Extract<BoardStreamStateV1, { state: 'reconnecting' }>['reason'];

type ConsumeOutcome =
  | { kind: 'reconnect'; reason: ReconnectReason; retryAfterMs: number; failureAttempt: boolean }
  | { kind: 'terminal'; failure: BoardStreamFailureV1 }
  | { kind: 'stopped'; reason: StopReason };

const validateOptions = (options: BoardStreamClientOptionsV1): void => {
  let origin: URL;
  try {
    origin = new URL(options.apiOrigin);
  } catch {
    throw new TypeError('apiOrigin must be an absolute HTTP(S) origin');
  }
  if ((origin.protocol !== 'http:' && origin.protocol !== 'https:') || origin.origin !== options.apiOrigin) {
    throw new TypeError('apiOrigin must be an exact HTTP(S) origin without a path');
  }
  if (!BoardIdParserV1.parse(options.boardId).ok) throw new TypeError('boardId is invalid');
  if (!TAB_ID_PATTERN.test(options.tabId)) throw new TypeError('tabId must be 22-character unpadded base64url');
  if (options.initialPresenceState !== 'online' && options.initialPresenceState !== 'away') {
    throw new TypeError('initialPresenceState is invalid');
  }
  if (!Number.isSafeInteger(options.minimumSnapshotSequence) || options.minimumSnapshotSequence < 0) {
    throw new TypeError('minimumSnapshotSequence must be a non-negative safe integer');
  }
  if (typeof options.dispatch?.open !== 'function') throw new TypeError('dispatch.open is required');
  for (const callback of [
    options.callbacks?.replaceSnapshot,
    options.callbacks?.refreshRevisionSnapshot,
    options.callbacks?.applyDurableEvent,
    options.callbacks?.replacePresence,
    options.callbacks?.onState,
  ]) if (typeof callback !== 'function') throw new TypeError('all stream callbacks are required');
  if (!(options.routeSignal instanceof AbortSignal)) throw new TypeError('routeSignal must be an AbortSignal');
};

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted || milliseconds <= 0) {
    resolve();
    return;
  }
  const timer = setTimeout(done, milliseconds);
  function done(): void {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  }
  signal.addEventListener('abort', done, { once: true });
});

const terminalState = (
  failure: BoardStreamFailureV1,
): Extract<BoardStreamStateV1, { state: 'terminal' }> | null => {
  if (failure.kind === 'rate_limited'
    || failure.kind === 'reconciliation_required'
    || failure.kind === 'transport') return null;
  return { state: 'terminal', failure };
};

export const createBoardStreamClientV1 = (
  options: BoardStreamClientOptionsV1,
): BoardStreamClientV1 => {
  validateOptions(options);

  let presenceState: BoardStreamPresenceStateV1 = options.initialPresenceState;
  let minimumSnapshotSequence = options.minimumSnapshotSequence;
  let reconciler = createBoardEventReconcilerV1({
    boardId: options.boardId,
    minimumSnapshotSequence,
  });
  let cursor: string | null = null;
  let lastAppliedSequence = 0;
  let startPromise: Promise<BoardStreamRunResultV1> | null = null;
  let settled: BoardStreamRunResultV1 | null = null;
  let stopReason: StopReason | null = options.routeSignal.aborted ? 'route_abort' : null;
  let currentController: AbortController | null = null;
  let recycleReason: 'planned_recycle' | null = null;
  let invalidCursorResetUsed = false;
  const lifetimeController = new AbortController();

  const requestStop = (reason: StopReason): void => {
    if (stopReason === null) stopReason = reason;
    lifetimeController.abort();
    currentController?.abort();
  };
  const onRouteAbort = (): void => requestStop('route_abort');
  options.routeSignal.addEventListener('abort', onRouteAbort, { once: true });

  const emitState = async (state: BoardStreamStateV1): Promise<boolean> => {
    try {
      await options.callbacks.onState(state);
      return true;
    } catch {
      return false;
    }
  };

  const callbackFailure = (
    callback: Extract<BoardStreamFailureV1, { kind: 'consumer_callback' }>['callback'],
  ): ConsumeOutcome => ({ kind: 'terminal', failure: { kind: 'consumer_callback', callback } });

  const consumeResponse = async (
    response: Response,
    heldSignal: AbortSignal,
    controller: AbortController,
    plannedIntent: () => boolean,
  ): Promise<ConsumeOutcome> => {
    if (response.headers.get('content-type')?.toLowerCase() !== 'text/event-stream; charset=utf-8'
      || response.body === null) {
      return { kind: 'terminal', failure: { kind: 'protocol', sourceStatus: 200, error: null } };
    }
    const parser = createSseFrameParserV1();
    const reader = response.body.getReader();
    let silenceBase = performance.now();
    try {
      while (true) {
        if (stopReason !== null) return { kind: 'stopped', reason: stopReason };
        const remaining = Math.max(0, SILENCE_TIMEOUT_MS - (performance.now() - silenceBase));
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        const readResult = await Promise.race([
          reader.read().then((result) => ({ kind: 'read' as const, result })),
          new Promise<{ kind: 'silence' }>((resolve) => {
            silenceTimer = setTimeout(() => resolve({ kind: 'silence' }), remaining);
          }),
        ]);
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        if (readResult.kind === 'silence') {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return { kind: 'reconnect', reason: 'heartbeat_timeout', retryAfterMs: 0, failureAttempt: true };
        }
        if (readResult.result.done) {
          parser.finish();
          return plannedIntent()
            ? { kind: 'reconnect', reason: 'planned_recycle', retryAfterMs: plannedRecycleJitterMsV1(), failureAttempt: false }
            : { kind: 'reconnect', reason: 'network', retryAfterMs: 0, failureAttempt: true };
        }
        const bytes = readResult.result.value;
        if (bytes.byteLength === 0) continue;
        if (plannedIntent()) continue;
        silenceBase = performance.now();
        const records = parser.push(bytes);
        for (const record of records) {
          if (record.kind === 'keepalive') continue;
          const evaluation = reconciler.evaluate(record.input);
          if (evaluation.kind === 'pending_effect') {
            try {
              if (evaluation.effect.kind === 'replace_snapshot') {
                await options.callbacks.replaceSnapshot(evaluation.effect.snapshot);
                const commit = reconciler.commit(evaluation.acceptanceId, { kind: 'effect_applied' });
                if (commit.kind !== 'continue') throw new TypeError('snapshot commit requested an invalid restart');
                cursor = commit.cursor;
                lastAppliedSequence = commit.lastAppliedSequence;
              } else if (evaluation.effect.kind === 'refresh_revision_snapshot') {
                const admission = await options.callbacks.refreshRevisionSnapshot(evaluation.effect.event);
                const commit = reconciler.commit(evaluation.acceptanceId, admission);
                if (commit.kind !== 'restart_without_cursor') throw new TypeError('revision commit did not request restart');
                cursor = null;
                minimumSnapshotSequence = commit.minimumSnapshotSequence;
                lastAppliedSequence = commit.minimumSnapshotSequence;
                controller.abort();
                await reader.cancel().catch(() => undefined);
                return { kind: 'reconnect', reason: 'revision_rebase', retryAfterMs: 0, failureAttempt: false };
              } else if (evaluation.effect.kind === 'apply_durable_event') {
                await options.callbacks.applyDurableEvent(evaluation.effect.event);
                const commit = reconciler.commit(evaluation.acceptanceId, { kind: 'effect_applied' });
                if (commit.kind !== 'continue') throw new TypeError('durable commit requested an invalid restart');
                cursor = commit.cursor;
                lastAppliedSequence = commit.lastAppliedSequence;
              } else {
                await options.callbacks.replacePresence(evaluation.effect.presence);
                const commit = reconciler.commit(evaluation.acceptanceId, { kind: 'effect_applied' });
                if (commit.kind !== 'continue') throw new TypeError('presence commit requested an invalid restart');
              }
            } catch {
              try {
                reconciler.reject(evaluation.acceptanceId);
              } catch {
                // A rejected callback may follow a commit-contract failure that retained its pending effect.
              }
              const callback = evaluation.effect.kind === 'replace_snapshot'
                ? 'snapshot'
                : evaluation.effect.kind === 'refresh_revision_snapshot'
                  ? 'revision_snapshot'
                  : evaluation.effect.kind === 'apply_durable_event'
                    ? 'durable_event'
                    : 'presence';
              return callbackFailure(callback);
            }
            if (!await emitState({ state: 'live', lastAppliedSequence })) return callbackFailure('state');
            silenceBase = performance.now();
            continue;
          }
          if (evaluation.kind === 'duplicate' || evaluation.kind === 'heartbeat') continue;
          if (evaluation.kind === 'resync_required') {
            reconciler.prepareForNoCursorSnapshot(lastAppliedSequence);
            cursor = null;
            minimumSnapshotSequence = lastAppliedSequence;
            controller.abort();
            await reader.cancel().catch(() => undefined);
            return { kind: 'reconnect', reason: 'server_resync', retryAfterMs: 0, failureAttempt: false };
          }
          if (evaluation.kind === 'stream_error') {
            if (evaluation.action === 'terminal') {
              return {
                kind: 'terminal',
                failure: {
                  kind: 'server_error',
                  error: evaluation.error,
                  retryable: false,
                  retryAfterMs: evaluation.retryAfterMs,
                },
              };
            }
            return {
              kind: 'reconnect',
              reason: 'server_retryable',
              retryAfterMs: evaluation.retryAfterMs ?? 0,
              failureAttempt: true,
            };
          }
          return { kind: 'terminal', failure: { kind: 'protocol', sourceStatus: 200, error: null } };
        }
        if (records.length > 0) silenceBase = performance.now();
      }
    } catch (error) {
      if (stopReason !== null) return { kind: 'stopped', reason: stopReason };
      if (recycleReason !== null || plannedIntent()) {
        return { kind: 'reconnect', reason: 'planned_recycle', retryAfterMs: plannedRecycleJitterMsV1(), failureAttempt: false };
      }
      if (error instanceof SseProtocolErrorV1) {
        return {
          kind: 'terminal',
          failure: { kind: 'protocol', sourceStatus: 200, error: error.boardError },
        };
      }
      if (heldSignal.aborted && !controller.signal.aborted) {
        return { kind: 'reconnect', reason: 'network', retryAfterMs: 0, failureAttempt: true };
      }
      return { kind: 'reconnect', reason: 'network', retryAfterMs: 0, failureAttempt: true };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };

  const run = async (): Promise<BoardStreamRunResultV1> => {
    let failureAttempt = 0;
    while (stopReason === null) {
      if (!await emitState({ state: 'connecting', attempt: failureAttempt })) {
        settled = { kind: 'terminal', failure: { kind: 'consumer_callback', callback: 'state' } };
        return settled;
      }
      const controller = new AbortController();
      currentController = controller;
      recycleReason = null;
      let planned = false;
      const plannedTimer = setTimeout(() => {
        planned = true;
        recycleReason = 'planned_recycle';
        controller.abort();
      }, PLANNED_INTENT_MS);
      let dispatchResult;
      try {
        dispatchResult = await options.dispatch.open(
          {
            apiOrigin: options.apiOrigin,
            boardId: options.boardId,
            tabId: options.tabId,
            presenceState,
            cursor,
            signal: controller.signal,
          },
          (response, heldSignal) => consumeResponse(response, heldSignal, controller, () => planned),
        );
      } catch {
        dispatchResult = {
          kind: 'consumed' as const,
          value: stopReason !== null
            ? { kind: 'stopped' as const, reason: stopReason }
            : recycleReason !== null
              ? {
                  kind: 'reconnect' as const,
                  reason: 'planned_recycle' as const,
                  retryAfterMs: plannedRecycleJitterMsV1(),
                  failureAttempt: false,
                }
              : { kind: 'reconnect' as const, reason: 'network' as const, retryAfterMs: 0, failureAttempt: true },
        };
      } finally {
        clearTimeout(plannedTimer);
        currentController = null;
      }
      if (stopReason !== null) {
        settled = { kind: 'stopped', reason: stopReason };
        return settled;
      }

      let outcome: ConsumeOutcome;
      if (dispatchResult.kind === 'consumed') outcome = dispatchResult.value;
      else if (dispatchResult.kind === 'reconciliation_required') {
        const failure: Extract<BoardStreamFailureV1, { kind: 'reconciliation_required' }> = {
          kind: 'reconciliation_required',
          sourceStatus: dispatchResult.sourceStatus,
          error: dispatchResult.error,
          acquisitionGeneration: dispatchResult.acquisitionGeneration,
          retryAfterMs: dispatchResult.retryAfterMs,
        };
        if (!await emitState({ state: 'reconciliation_required', failure })) {
          settled = { kind: 'terminal', failure: { kind: 'consumer_callback', callback: 'state' } };
          return settled;
        }
        settled = { kind: 'terminal', failure };
        return settled;
      } else if (dispatchResult.kind === 'protocol_error') {
        outcome = {
          kind: 'terminal',
          failure: { kind: 'protocol', sourceStatus: dispatchResult.sourceStatus, error: dispatchResult.error },
        };
      } else if (dispatchResult.sourceStatus === 400) {
        if (cursor !== null && !invalidCursorResetUsed) {
          invalidCursorResetUsed = true;
          cursor = null;
          reconciler.prepareForNoCursorSnapshot(lastAppliedSequence);
          minimumSnapshotSequence = lastAppliedSequence;
          outcome = { kind: 'reconnect', reason: 'invalid_cursor_reset', retryAfterMs: 0, failureAttempt: false };
        } else outcome = { kind: 'terminal', failure: { kind: 'invalid_request', sourceStatus: 400, error: dispatchResult.error } };
      } else if (dispatchResult.sourceStatus === 403) {
        outcome = { kind: 'terminal', failure: { kind: 'forbidden', sourceStatus: 403, error: dispatchResult.error } };
      } else if (dispatchResult.sourceStatus === 404) {
        outcome = { kind: 'terminal', failure: { kind: 'not_found', sourceStatus: 404, error: dispatchResult.error } };
      } else if (dispatchResult.sourceStatus === 429) {
        const retryAfterMs = dispatchResult.retryAfterMs ?? 1_000;
        outcome = { kind: 'reconnect', reason: 'rate_limited', retryAfterMs, failureAttempt: true };
      } else {
        outcome = { kind: 'terminal', failure: { kind: 'internal_error', sourceStatus: 500, error: dispatchResult.error } };
      }

      if (outcome.kind === 'stopped') {
        settled = outcome;
        return outcome;
      }
      if (outcome.kind === 'terminal') {
        const state = terminalState(outcome.failure);
        if (state !== null && !await emitState(state)) {
          settled = { kind: 'terminal', failure: { kind: 'consumer_callback', callback: 'state' } };
          return settled;
        }
        settled = { kind: 'terminal', failure: outcome.failure };
        return settled;
      }
      if (outcome.failureAttempt) failureAttempt += 1;
      const retryAfterMs = !outcome.failureAttempt
        ? outcome.retryAfterMs
        : Math.max(outcome.retryAfterMs, reconnectBackoffMsV1(Math.max(1, failureAttempt)));
      if (!await emitState({ state: 'reconnecting', reason: outcome.reason, retryAfterMs })) {
        settled = { kind: 'terminal', failure: { kind: 'consumer_callback', callback: 'state' } };
        return settled;
      }
      await delay(retryAfterMs, lifetimeController.signal);
      if (outcome.reason === 'revision_rebase' || outcome.reason === 'server_resync' || outcome.reason === 'invalid_cursor_reset') {
        reconciler = createBoardEventReconcilerV1({
          boardId: options.boardId,
          minimumSnapshotSequence,
        });
      }
      recycleReason = null;
    }
    settled = { kind: 'stopped', reason: stopReason ?? 'consumer_stop' };
    return settled;
  };

  const start = (): Promise<BoardStreamRunResultV1> => {
    if (startPromise === null) startPromise = run();
    return startPromise;
  };

  const setPresenceState = (state: BoardStreamPresenceStateV1): void => {
    if (state !== 'online' && state !== 'away') throw new TypeError('presence state is invalid');
    if (presenceState === state || stopReason !== null) return;
    presenceState = state;
    recycleReason = 'planned_recycle';
    currentController?.abort();
  };

  const stop = async (reason: StopReason = 'consumer_stop'): Promise<BoardStreamRunResultV1> => {
    if (settled !== null) return settled;
    requestStop(reason);
    if (startPromise === null) {
      settled = { kind: 'stopped', reason: stopReason ?? reason };
      return settled;
    }
    return startPromise;
  };

  return { start, setPresenceState, stop };
};
