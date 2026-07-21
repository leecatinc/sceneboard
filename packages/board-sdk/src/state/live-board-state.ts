import type { BoardSnapshotV1, PresenceSummaryV1, RevisionId } from '@sceneboard/board-schema';
import type { BoardIncrementalDurableEnvelopeV1 } from '../events/index.js';
import type { BoardStreamStateV1 } from '../sse/index.js';

import type { CorrelatedHistoryNavigationV1, SafeBoardUiErrorV1 } from '../client/index.js';

export type BoardViewModeV1 =
  | { kind: 'live' }
  | {
      kind: 'history';
      snapshot: BoardSnapshotV1;
      navigation: CorrelatedHistoryNavigationV1;
      observedLiveRevisionId: RevisionId;
    };

export type LiveBoardStateV1 = {
  liveSnapshot: BoardSnapshotV1;
  mode: BoardViewModeV1;
  presence: readonly PresenceSummaryV1[];
  connection: BoardStreamStateV1;
  pendingNavigation: boolean;
  navigationError: SafeBoardUiErrorV1 | null;
};

export const createLiveBoardStateV1 = (snapshot: BoardSnapshotV1): LiveBoardStateV1 => ({
  liveSnapshot: snapshot,
  mode: { kind: 'live' },
  presence: [],
  connection: { state: 'idle' },
  pendingNavigation: false,
  navigationError: null,
});

export const visibleBoardSnapshotV1 = (state: LiveBoardStateV1): BoardSnapshotV1 =>
  state.mode.kind === 'history' ? state.mode.snapshot : state.liveSnapshot;

export const hasLiveUpdateV1 = (state: LiveBoardStateV1): boolean =>
  state.mode.kind === 'history' &&
  state.liveSnapshot.revision.revisionId !== state.mode.observedLiveRevisionId;

export const replaceLiveSnapshotV1 = (
  state: LiveBoardStateV1,
  snapshot: BoardSnapshotV1,
): LiveBoardStateV1 => ({ ...state, liveSnapshot: snapshot });

export const replacePresenceV1 = (
  state: LiveBoardStateV1,
  presence: readonly PresenceSummaryV1[],
): LiveBoardStateV1 => ({ ...state, presence: [...presence] });

export const replaceConnectionStateV1 = (
  state: LiveBoardStateV1,
  connection: BoardStreamStateV1,
): LiveBoardStateV1 => ({ ...state, connection });

export const applyDurableEventV1 = (
  state: LiveBoardStateV1,
  envelope: BoardIncrementalDurableEnvelopeV1,
): LiveBoardStateV1 => {
  if (envelope.boardId !== state.liveSnapshot.boardId)
    throw new TypeError('durable event targets another board');
  const data = envelope.data;
  if (data.type === 'hitl.updated') {
    const index = state.liveSnapshot.hitl.findIndex(
      (item) => item.hitlRequestId === data.hitl.hitlRequestId,
    );
    if (index < 0) {
      return {
        ...state,
        liveSnapshot: {
          ...state.liveSnapshot,
          hitl: [...state.liveSnapshot.hitl, data.hitl],
        },
      };
    }
    const hitl = [...state.liveSnapshot.hitl];
    hitl[index] = data.hitl;
    return { ...state, liveSnapshot: { ...state.liveSnapshot, hitl } };
  }
  const key = `${data.artifact.artifact.artifactId}\0${data.artifact.artifact.versionId}`;
  const index = state.liveSnapshot.artifacts.findIndex(
    (item) => `${item.artifact.artifactId}\0${item.artifact.versionId}` === key,
  );
  if (index < 0) {
    return {
      ...state,
      liveSnapshot: {
        ...state.liveSnapshot,
        artifacts: [...state.liveSnapshot.artifacts, data.artifact],
      },
    };
  }
  const artifacts = [...state.liveSnapshot.artifacts];
  artifacts[index] = data.artifact;
  return { ...state, liveSnapshot: { ...state.liveSnapshot, artifacts } };
};

export const beginHistoryNavigationV1 = (state: LiveBoardStateV1): LiveBoardStateV1 => ({
  ...state,
  pendingNavigation: true,
  navigationError: null,
});

export const enterHistoryV1 = (
  state: LiveBoardStateV1,
  snapshot: BoardSnapshotV1,
  navigation: CorrelatedHistoryNavigationV1,
): LiveBoardStateV1 => {
  if (
    snapshot.boardId !== state.liveSnapshot.boardId ||
    snapshot.revision.revisionId !== navigation.revisionId
  ) {
    throw new TypeError('historical snapshot does not correlate');
  }
  return {
    ...state,
    mode: {
      kind: 'history',
      snapshot,
      navigation,
      observedLiveRevisionId: state.liveSnapshot.revision.revisionId,
    },
    pendingNavigation: false,
    navigationError: null,
  };
};

export const failHistoryNavigationV1 = (
  state: LiveBoardStateV1,
  error: SafeBoardUiErrorV1,
): LiveBoardStateV1 => ({ ...state, pendingNavigation: false, navigationError: error });

export const enterLatestV1 = (
  state: LiveBoardStateV1,
  snapshot: BoardSnapshotV1,
): LiveBoardStateV1 => {
  if (snapshot.boardId !== state.liveSnapshot.boardId)
    throw new TypeError('latest snapshot targets another board');
  return {
    ...state,
    liveSnapshot: snapshot,
    mode: { kind: 'live' },
    pendingNavigation: false,
    navigationError: null,
  };
};
