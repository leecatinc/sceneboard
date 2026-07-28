'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BoardIdParserV1, type BoardSnapshot, type RevisionId } from '@sceneboard/board-schema';
import {
  correlateHistoryNavigationV1,
  RequestEpochV1,
  toSafeBoardUiErrorV1,
  type SafeBoardUiErrorV1,
} from '@sceneboard/board-sdk/client';
import {
  createBoardStreamClientV1,
  createBoardStreamClientV2,
  createBoardStreamTabIdV1,
  type BoardStreamCallbacksV2,
  type BoardStreamClientV1,
  type BoardStreamPresenceStateV1,
} from '@sceneboard/board-sdk/sse';
import {
  applyDurableEventV1,
  beginHistoryNavigationV1,
  createLiveBoardStateV1,
  enterHistoryV1,
  enterLatestV1,
  failHistoryNavigationV1,
  hasLiveUpdateV1,
  replaceConnectionStateV1,
  replaceLiveSnapshotV1,
  replacePresenceV1,
  visibleBoardSnapshotV1,
  type LiveBoardStateV1,
} from '@sceneboard/board-sdk/state';

import { BoardApiClient, type ApiResult } from '../api/board-api';
import { authSessionClient } from '../auth/session-client';

type BoardScreenPhase = 'loading' | 'ready' | 'invalid';

const localError = (result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): SafeBoardUiErrorV1 => {
  if (result.kind === 'board_error') return toSafeBoardUiErrorV1(result.error);
  if (result.kind === 'corrupt_response')
    return {
      kind: 'corrupt',
      message: 'The board response could not be verified.',
      retryable: false,
    };
  if (result.kind === 'unsupported_browser')
    return {
      kind: 'unknown',
      message: 'This browser cannot protect the SceneBoard session.',
      retryable: false,
    };
  if (result.kind === 'api_error' && result.status === 404)
    return { kind: 'not_found', message: 'This board was not found.', retryable: false };
  return {
    kind: 'offline',
    message: 'The latest board view could not be reached.',
    retryable: true,
  };
};

export function useBoardSession(boardIdValue: string) {
  const [phase, setPhase] = useState<BoardScreenPhase>('loading');
  const [state, setState] = useState<LiveBoardStateV1 | null>(null);
  const [title, setTitle] = useState('SceneBoard');
  const [error, setError] = useState<SafeBoardUiErrorV1 | null>(null);
  const api = useMemo(() => new BoardApiClient(authSessionClient().sharedCoordinator()), []);
  const routeEpoch = useRef(new RequestEpochV1());
  const navigationEpoch = useRef(new RequestEpochV1());
  const stream = useRef<BoardStreamClientV1 | null>(null);
  const initialAbort = useRef<AbortController | null>(null);
  const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;

  const startStream = useCallback(
    async (snapshot: BoardSnapshot) => {
      if (apiOrigin === undefined) throw new TypeError('NEXT_PUBLIC_BOARD_API_URL is required');
      if (stream.current !== null) await stream.current.stop('context_loss');
      const epoch = routeEpoch.current.advance();
      const callbacks: BoardStreamCallbacksV2 = {
        replaceSnapshot(next) {
          if (!routeEpoch.current.isCurrent(epoch)) throw new TypeError('stale route callback');
          setState((current) =>
            current === null ? createLiveBoardStateV1(next) : replaceLiveSnapshotV1(current, next),
          );
        },
        async refreshRevisionSnapshot() {
          if (!routeEpoch.current.isCurrent(epoch)) throw new TypeError('stale route callback');
          const result = await api.getBoard(snapshot.boardId);
          if (!routeEpoch.current.isCurrent(epoch) || result.kind !== 'ok')
            throw new TypeError('revision refresh was not admitted');
          setState((current) =>
            current === null
              ? createLiveBoardStateV1(result.value.snapshot)
              : replaceLiveSnapshotV1(current, result.value.snapshot),
          );
          return {
            kind: 'authoritative_revision_snapshot',
            lastEventSequence: result.value.snapshot.lastEventSequence,
          };
        },
        applyDurableEvent(event) {
          if (!routeEpoch.current.isCurrent(epoch)) throw new TypeError('stale route callback');
          setState((current) => {
            if (current === null) throw new TypeError('live state is unavailable');
            return applyDurableEventV1(current, event);
          });
        },
        replacePresence(presence) {
          if (!routeEpoch.current.isCurrent(epoch)) throw new TypeError('stale route callback');
          setState((current) =>
            current === null ? current : replacePresenceV1(current, presence),
          );
        },
        onState(connection) {
          if (!routeEpoch.current.isCurrent(epoch)) throw new TypeError('stale route callback');
          setState((current) =>
            current === null ? current : replaceConnectionStateV1(current, connection),
          );
        },
      };
      const initialPresenceState: BoardStreamPresenceStateV1 =
        document.visibilityState === 'visible' ? 'online' : 'away';
      const common = {
        apiOrigin,
        boardId: snapshot.boardId,
        tabId: createBoardStreamTabIdV1(),
        initialPresenceState,
        minimumSnapshotSequence: snapshot.lastEventSequence,
        dispatch: authSessionClient().sharedCoordinator(),
        routeSignal: new AbortController().signal,
        callbacks,
      };
      const client =
        'document' in snapshot
          ? createBoardStreamClientV2({ ...common, documentSchemaVersion: 2 })
          : createBoardStreamClientV1(common);
      stream.current = client;
      const visibility = () =>
        client.setPresenceState(document.visibilityState === 'visible' ? 'online' : 'away');
      document.addEventListener('visibilitychange', visibility);
      void client
        .start()
        .finally(() => document.removeEventListener('visibilitychange', visibility));
    },
    [api, apiOrigin],
  );

  const load = useCallback(async () => {
    const parsed = BoardIdParserV1.parse(boardIdValue);
    if (!parsed.ok) {
      setPhase('invalid');
      setError({ kind: 'not_found', message: 'This board address is invalid.', retryable: false });
      return;
    }
    initialAbort.current?.abort();
    const controller = new AbortController();
    initialAbort.current = controller;
    setPhase('loading');
    const result = await api.getBoard(parsed.data.value, controller.signal);
    if (controller.signal.aborted) return;
    if (result.kind !== 'ok') {
      setError(localError(result));
      setPhase('invalid');
      return;
    }
    const next = createLiveBoardStateV1(result.value.snapshot);
    setTitle(result.value.board.title);
    setState(next);
    setError(null);
    setPhase('ready');
    await startStream(result.value.snapshot);
  }, [api, boardIdValue, startStream]);

  useEffect(() => {
    void load();
    return () => {
      initialAbort.current?.abort();
      routeEpoch.current.advance();
      navigationEpoch.current.advance();
      if (stream.current !== null) void stream.current.stop('route_abort');
    };
  }, [load]);

  const navigateHistory = useCallback(
    async (revisionId: RevisionId) => {
      const epoch = navigationEpoch.current.advance();
      setState((current) => (current === null ? current : beginHistoryNavigationV1(current)));
      const result = await api.getHistoryRevision(boardIdValue, revisionId);
      if (!navigationEpoch.current.isCurrent(epoch)) return;
      if (result.kind !== 'ok') {
        const nextError = localError(result);
        setState((current) =>
          current === null ? current : failHistoryNavigationV1(current, nextError),
        );
        return;
      }
      try {
        const navigation = correlateHistoryNavigationV1(result.value.entry, result.value.metadata);
        setState((current) =>
          current === null ? current : enterHistoryV1(current, result.value.snapshot, navigation),
        );
      } catch {
        const nextError: SafeBoardUiErrorV1 = {
          kind: 'corrupt',
          message: 'History navigation could not be verified.',
          retryable: false,
        };
        setState((current) =>
          current === null ? current : failHistoryNavigationV1(current, nextError),
        );
      }
    },
    [api, boardIdValue],
  );

  const previous = useCallback(() => {
    if (state === null) return;
    const revisionId =
      state.mode.kind === 'history'
        ? state.mode.navigation.previousRevisionId
        : state.liveSnapshot.revision.previousRevisionId;
    if (revisionId !== null) void navigateHistory(revisionId);
  }, [navigateHistory, state]);

  const next = useCallback(() => {
    if (state?.mode.kind !== 'history' || state.mode.navigation.nextRevisionId === null) return;
    void navigateHistory(state.mode.navigation.nextRevisionId);
  }, [navigateHistory, state]);

  const latest = useCallback(async () => {
    if (state?.mode.kind !== 'history') return;
    const epoch = navigationEpoch.current.advance();
    setState((current) => (current === null ? current : beginHistoryNavigationV1(current)));
    const result = await api.getBoard(boardIdValue);
    if (!navigationEpoch.current.isCurrent(epoch)) return;
    if (result.kind !== 'ok') {
      const nextError = localError(result);
      setState((current) =>
        current === null ? current : failHistoryNavigationV1(current, nextError),
      );
      return;
    }
    setState((current) =>
      current === null
        ? createLiveBoardStateV1(result.value.snapshot)
        : enterLatestV1(current, result.value.snapshot),
    );
    setTitle(result.value.board.title);
    await startStream(result.value.snapshot);
  }, [api, boardIdValue, startStream, state?.mode.kind]);

  const rename = useCallback(
    async (nextTitle: string): Promise<boolean> => {
      const result = await api.renameBoard(boardIdValue, nextTitle);
      if (result.kind !== 'ok') return false;
      setTitle(result.value.title);
      return true;
    },
    [api, boardIdValue],
  );

  return {
    phase,
    title,
    state,
    error,
    visibleSnapshot: state === null ? null : visibleBoardSnapshotV1(state),
    liveUpdated: state === null ? false : hasLiveUpdateV1(state),
    retry: load,
    previous,
    next,
    latest,
    rename,
  };
}
