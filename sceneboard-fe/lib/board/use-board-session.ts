'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BoardIdParserV1,
  type BoardSessionAccessV1,
  type BoardSnapshot,
  type PageCursorV1,
  type RevisionId,
} from '@sceneboard/board-schema';
import {
  correlateHistoryNavigationV1,
  normalizeHistoryListV1,
  RequestEpochV1,
  toSafeBoardUiErrorV1,
  type NormalizedRetainedHistoryRowV1,
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
import {
  capabilitySettlementIsCurrentV1,
  EMPTY_BOARD_SESSION_ACCESS_V1,
  sameBoardSessionAccessV1,
  type BoardCapabilityRequestIdentityV1,
} from './board-capabilities';
import {
  historySettlementIsCurrentV1,
  mergeHistoryPageV1,
  type HistoryPageStateV1,
  type HistoryRequestIdentityV1,
} from './history-selection';

type BoardScreenPhase = 'loading' | 'ready' | 'invalid';

export type RetainedHistoryDropdownV1 = {
  isOpen: boolean;
  status: 'idle' | 'loading' | 'loading_more' | 'ready' | 'error';
  rows: readonly NormalizedRetainedHistoryRowV1[];
  nextCursor: PageCursorV1 | null;
  failedCursor: PageCursorV1 | null;
  announcement: 'history_unavailable' | 'selected_unavailable' | null;
};

const EMPTY_HISTORY_DROPDOWN: RetainedHistoryDropdownV1 = {
  isOpen: false,
  status: 'idle',
  rows: [],
  nextCursor: null,
  failedCursor: null,
  announcement: null,
};

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
  const [sessionAccess, setSessionAccess] = useState<BoardSessionAccessV1>(
    EMPTY_BOARD_SESSION_ACCESS_V1,
  );
  const [capabilityUiEpoch, setCapabilityUiEpoch] = useState(0);
  const sessionAccessRef = useRef<BoardSessionAccessV1>(EMPTY_BOARD_SESSION_ACCESS_V1);
  const api = useMemo(() => new BoardApiClient(authSessionClient().sharedCoordinator()), []);
  const routeEpoch = useRef(new RequestEpochV1());
  const navigationEpoch = useRef(new RequestEpochV1());
  const selectionEpoch = useRef(0);
  const pageEpoch = useRef(0);
  const listRequest = useRef<HistoryRequestIdentityV1 | null>(null);
  const navigationAbort = useRef<AbortController | null>(null);
  const historyPage = useRef<HistoryPageStateV1 | null>(null);
  const stream = useRef<BoardStreamClientV1 | null>(null);
  const initialAbort = useRef<AbortController | null>(null);
  const capabilityUiEpochRef = useRef(0);
  const capabilityRequest = useRef<{
    identity: BoardCapabilityRequestIdentityV1;
    controller: AbortController;
  } | null>(null);
  const writeAbort = useRef<AbortController | null>(null);
  const writeIdentity = useRef<BoardCapabilityRequestIdentityV1 | null>(null);
  const [historyDropdown, setHistoryDropdown] =
    useState<RetainedHistoryDropdownV1>(EMPTY_HISTORY_DROPDOWN);
  const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;

  const refreshCapabilities = useCallback(async (): Promise<boolean> => {
    capabilityRequest.current?.controller.abort();
    const controller = new AbortController();
    const identity: BoardCapabilityRequestIdentityV1 = {
      uiEpoch: capabilityUiEpochRef.current + 1,
      boardId: boardIdValue,
      action: 'capabilities.get',
    };
    capabilityUiEpochRef.current = identity.uiEpoch;
    capabilityRequest.current = { identity, controller };
    const result = await api.getCapabilities(boardIdValue, controller.signal);
    if (
      controller.signal.aborted ||
      !capabilitySettlementIsCurrentV1(identity, capabilityRequest.current?.identity ?? null)
    )
      return false;
    capabilityRequest.current = null;
    setCapabilityUiEpoch(identity.uiEpoch);
    if (result.kind === 'ok') {
      const next = result.value.sessionAccess;
      const current = sessionAccessRef.current;
      if (next.capabilityEpoch >= current.capabilityEpoch) {
        if (!sameBoardSessionAccessV1(current, next)) {
          writeAbort.current?.abort();
          writeIdentity.current = null;
        }
        sessionAccessRef.current = next;
        setSessionAccess(next);
      }
      return true;
    }
    const notFound =
      (result.kind === 'api_error' && result.status === 404) ||
      (result.kind === 'board_error' && result.error.code === 'BOARD_NOT_FOUND');
    if (notFound) {
      writeAbort.current?.abort();
      writeIdentity.current = null;
      const next = {
        ...EMPTY_BOARD_SESSION_ACCESS_V1,
        capabilityEpoch: sessionAccessRef.current.capabilityEpoch + 1,
      };
      sessionAccessRef.current = next;
      setSessionAccess(next);
    }
    return false;
  }, [api, boardIdValue]);

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
    capabilityRequest.current?.controller.abort();
    capabilityRequest.current = null;
    const controller = new AbortController();
    initialAbort.current = controller;
    setPhase('loading');
    writeAbort.current?.abort();
    writeAbort.current = null;
    writeIdentity.current = null;
    sessionAccessRef.current = EMPTY_BOARD_SESSION_ACCESS_V1;
    setSessionAccess(EMPTY_BOARD_SESSION_ACCESS_V1);
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
    void refreshCapabilities();
    await startStream(result.value.snapshot);
  }, [api, boardIdValue, refreshCapabilities, startStream]);

  useEffect(() => {
    void load();
    return () => {
      initialAbort.current?.abort();
      capabilityRequest.current?.controller.abort();
      capabilityRequest.current = null;
      writeAbort.current?.abort();
      writeAbort.current = null;
      writeIdentity.current = null;
      capabilityUiEpochRef.current += 1;
      listRequest.current?.controller.abort();
      listRequest.current = null;
      navigationAbort.current?.abort();
      navigationAbort.current = null;
      historyPage.current = null;
      selectionEpoch.current += 1;
      pageEpoch.current += 1;
      routeEpoch.current.advance();
      navigationEpoch.current.advance();
      if (stream.current !== null) void stream.current.stop('route_abort');
    };
  }, [load]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshCapabilities();
    };
    const interval = window.setInterval(refreshWhenVisible, 2_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [phase, refreshCapabilities]);

  const loadHistoryPage = useCallback(
    async (cursor: PageCursorV1 | null) => {
      const snapshot = state?.liveSnapshot;
      if (snapshot === undefined) return;
      const active = listRequest.current;
      if (
        active !== null &&
        active.kind === 'list' &&
        active.cursor === cursor &&
        !active.controller.signal.aborted
      )
        return;
      active?.controller.abort();
      const controller = new AbortController();
      const identity: HistoryRequestIdentityV1 = {
        boardId: boardIdValue,
        routeKey: boardIdValue,
        selectionEpoch: selectionEpoch.current,
        pageEpoch: pageEpoch.current,
        kind: 'list',
        cursor,
        revisionId: null,
        controller,
      };
      listRequest.current = identity;
      setHistoryDropdown((current) => ({
        ...current,
        status: cursor === null ? 'loading' : 'loading_more',
        failedCursor: null,
        announcement: null,
      }));
      const result = await api.listHistory(boardIdValue, cursor, controller.signal);
      if (!historySettlementIsCurrentV1(identity, listRequest.current)) return;
      listRequest.current = null;
      if (result.kind !== 'ok') {
        pageEpoch.current += 1;
        setHistoryDropdown((current) => ({
          ...current,
          status: 'error',
          failedCursor: cursor,
          announcement: 'history_unavailable',
        }));
        return;
      }
      try {
        const page = normalizeHistoryListV1({
          entries: result.value.entries,
          metadata: result.value.metadata,
          nextCursor: result.value.nextCursor,
          requestedCursor: cursor,
          latest: {
            revisionId: snapshot.revision.revisionId,
            revisionNumber: snapshot.revision.revisionNumber,
          },
        });
        const next = mergeHistoryPageV1(historyPage.current, page, cursor);
        historyPage.current = next;
        setHistoryDropdown((current) => ({
          ...current,
          status: 'ready',
          rows: next.rows,
          nextCursor: next.nextCursor,
          failedCursor: null,
          announcement: null,
        }));
      } catch {
        pageEpoch.current += 1;
        setHistoryDropdown((current) => ({
          ...current,
          status: 'error',
          failedCursor: cursor,
          announcement: 'history_unavailable',
        }));
      }
    },
    [api, boardIdValue, state?.liveSnapshot],
  );

  const openHistory = useCallback(() => {
    pageEpoch.current += 1;
    listRequest.current?.controller.abort();
    listRequest.current = null;
    historyPage.current = null;
    setHistoryDropdown({
      ...EMPTY_HISTORY_DROPDOWN,
      isOpen: true,
      status: 'loading',
    });
    void loadHistoryPage(null);
  }, [loadHistoryPage]);

  const closeHistory = useCallback(() => {
    selectionEpoch.current += 1;
    pageEpoch.current += 1;
    navigationEpoch.current.advance();
    listRequest.current?.controller.abort();
    listRequest.current = null;
    navigationAbort.current?.abort();
    navigationAbort.current = null;
    setHistoryDropdown((current) => ({
      ...current,
      isOpen: false,
      status: current.status === 'loading_more' ? 'ready' : current.status,
    }));
  }, []);

  const loadMoreHistory = useCallback(() => {
    const cursor = historyPage.current?.nextCursor ?? null;
    if (cursor !== null) void loadHistoryPage(cursor);
  }, [loadHistoryPage]);

  const retryHistory = useCallback(() => {
    const cursor = historyDropdown.failedCursor;
    pageEpoch.current += 1;
    listRequest.current?.controller.abort();
    listRequest.current = null;
    if (cursor === null) historyPage.current = null;
    void loadHistoryPage(cursor);
  }, [historyDropdown.failedCursor, loadHistoryPage]);

  const navigateHistory = useCallback(
    async (revisionId: RevisionId): Promise<'ok' | 'unavailable' | 'failed'> => {
      const epoch = navigationEpoch.current.advance();
      const selectedEpoch = selectionEpoch.current;
      navigationAbort.current?.abort();
      const controller = new AbortController();
      navigationAbort.current = controller;
      setState((current) => (current === null ? current : beginHistoryNavigationV1(current)));
      const result = await api.getHistoryRevision(boardIdValue, revisionId, controller.signal);
      if (
        controller.signal.aborted ||
        navigationAbort.current !== controller ||
        selectionEpoch.current !== selectedEpoch ||
        !navigationEpoch.current.isCurrent(epoch)
      )
        return 'failed';
      navigationAbort.current = null;
      if (result.kind !== 'ok') {
        const isUnavailable =
          (result.kind === 'api_error' && result.status === 404) ||
          (result.kind === 'board_error' && result.error.code === 'BOARD_NOT_FOUND');
        if (isUnavailable) return 'unavailable';
        const nextError = localError(result);
        setState((current) =>
          current === null ? current : failHistoryNavigationV1(current, nextError),
        );
        return 'failed';
      }
      try {
        const latestRevision = state?.liveSnapshot.revision;
        if (latestRevision === undefined) throw new TypeError('live revision is unavailable');
        const navigation = correlateHistoryNavigationV1(result.value.entry, result.value.metadata, {
          revisionId: latestRevision.revisionId,
          revisionNumber: latestRevision.revisionNumber,
        });
        setState((current) =>
          current === null ? current : enterHistoryV1(current, result.value.snapshot, navigation),
        );
        return 'ok';
      } catch {
        const nextError: SafeBoardUiErrorV1 = {
          kind: 'corrupt',
          message: 'History navigation could not be verified.',
          retryable: false,
        };
        setState((current) =>
          current === null ? current : failHistoryNavigationV1(current, nextError),
        );
        return 'failed';
      }
    },
    [api, boardIdValue, state?.liveSnapshot.revision],
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

  const latest = useCallback(
    async (force = false): Promise<boolean> => {
      if (!force && state?.mode.kind !== 'history') return false;
      const epoch = navigationEpoch.current.advance();
      const selectedEpoch = selectionEpoch.current;
      navigationAbort.current?.abort();
      const controller = new AbortController();
      navigationAbort.current = controller;
      setState((current) => (current === null ? current : beginHistoryNavigationV1(current)));
      const result = await api.getBoard(boardIdValue, controller.signal);
      if (
        controller.signal.aborted ||
        navigationAbort.current !== controller ||
        selectionEpoch.current !== selectedEpoch ||
        !navigationEpoch.current.isCurrent(epoch)
      )
        return false;
      navigationAbort.current = null;
      if (result.kind !== 'ok') {
        const nextError = localError(result);
        setState((current) =>
          current === null ? current : failHistoryNavigationV1(current, nextError),
        );
        return false;
      }
      setState((current) =>
        current === null
          ? createLiveBoardStateV1(result.value.snapshot)
          : enterLatestV1(current, result.value.snapshot),
      );
      setTitle(result.value.board.title);
      await startStream(result.value.snapshot);
      return true;
    },
    [api, boardIdValue, startStream, state?.mode.kind],
  );

  const selectHistoryRevision = useCallback(
    async (revisionId: RevisionId) => {
      selectionEpoch.current += 1;
      pageEpoch.current += 1;
      listRequest.current?.controller.abort();
      listRequest.current = null;
      setHistoryDropdown((current) => ({ ...current, isOpen: false, announcement: null }));
      const result = await navigateHistory(revisionId);
      if (result !== 'unavailable') return;
      const fallbackSucceeded = await latest(true);
      if (!fallbackSucceeded) return;
      historyPage.current = null;
      setHistoryDropdown((current) => ({
        ...current,
        rows: [],
        nextCursor: null,
        status: 'idle',
        announcement: 'selected_unavailable',
      }));
    },
    [latest, navigateHistory],
  );

  const selectLatestHistory = useCallback(async () => {
    selectionEpoch.current += 1;
    pageEpoch.current += 1;
    listRequest.current?.controller.abort();
    listRequest.current = null;
    setHistoryDropdown((current) => ({ ...current, isOpen: false, announcement: null }));
    await latest(true);
  }, [latest]);

  const rename = useCallback(
    async (nextTitle: string): Promise<boolean> => {
      if (!sessionAccessRef.current.authorizationCapabilities.includes('board.write')) return false;
      writeAbort.current?.abort();
      const controller = new AbortController();
      writeAbort.current = controller;
      const expected: BoardCapabilityRequestIdentityV1 = {
        uiEpoch: (writeIdentity.current?.uiEpoch ?? 0) + 1,
        boardId: boardIdValue,
        action: 'board.rename',
      };
      const expectedCapabilityEpoch = sessionAccessRef.current.capabilityEpoch;
      writeIdentity.current = expected;
      const result = await api.renameBoard(boardIdValue, nextTitle, controller.signal);
      if (
        controller.signal.aborted ||
        writeAbort.current !== controller ||
        !capabilitySettlementIsCurrentV1(expected, writeIdentity.current) ||
        expectedCapabilityEpoch !== sessionAccessRef.current.capabilityEpoch ||
        result.kind !== 'ok'
      )
        return false;
      writeAbort.current = null;
      writeIdentity.current = null;
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
    historyDropdown,
    openHistory,
    closeHistory,
    loadMoreHistory,
    retryHistory,
    selectHistoryRevision,
    selectLatestHistory,
    rename,
    sessionAccess,
    capabilityUiEpoch,
    refreshCapabilities,
  };
}
