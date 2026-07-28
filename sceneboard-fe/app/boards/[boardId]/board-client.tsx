'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { PageId } from '@sceneboard/board-schema';
import {
  BoardRenderer,
  type DrawingViewStateV1,
  type RendererComponentV1,
} from '@sceneboard/board-ui/renderer';
import type { ArtifactLoadPortV1 } from '@sceneboard/board-ui/artifact';
import type { ArtifactViewModeV1 } from '@sceneboard/board-ui/artifact';
import { HitlBlock, type HitlInteractionControllerV1 } from '@sceneboard/board-ui/interaction';

import { BoardStatePanel } from '../../../components/board/BoardStatePanel';
import { BoardPairingControl } from '../../../components/board/BoardPairingControl';
import { BoardArchiveControl } from '../../../components/board/BoardArchiveControl';
import {
  BoardConnectionsSlot,
  BoardHistorySlot,
  BoardIdentitySlot,
} from '../../../components/board/BoardChromeSlots';
import { PageNavigationControls } from '../../../components/board/PageNavigationControls';
import { PageDisplayModeControls } from '../../../components/board/PageDisplayModeControls';
import { PageMoveModeControls } from '../../../components/board/PageMoveModeControls';
import { PresentationStage } from '../../../components/board/PresentationStage';
import { PresentationModeControls } from '../../../components/board/PresentationModeControls';
import { PresentationControlOverlay } from '../../../components/board/PresentationControlOverlay';
import { HitlDecisionWorkspace } from '../../../components/board/HitlDecisionWorkspace';
import { StatusRail } from '../../../components/board/StatusRail';
import { ResponsiveBoardChrome } from '../../../components/board/ResponsiveBoardChrome';
import type { MobileBoardDrawerSlotsV1 } from '../../../components/board/MobileBoardDrawer';
import { useBoardSession } from '../../../lib/board/use-board-session';
import { BoardApiClient } from '../../../lib/api/board-api';
import { authSessionClient } from '../../../lib/auth/session-client';
import { useHitlInteractionController } from '../../../lib/board/use-hitl-interaction-controller';
import { selectUnplacedOpenHitlV1 } from '../../../lib/board/unplaced-hitl';
import { shouldPreferExpandedDecisionWorkspaceV1 } from '../../../lib/board/hitl-decision-workspace-policy';
import { useI18n } from '../../../components/i18n/I18nProvider';
import {
  canResetArtifactViewV1,
  createArtifactViewRegistryV1,
  reduceArtifactViewRegistryV1,
  selectedArtifactZoomV1,
} from '../../../lib/board/artifact-view-registry';
import {
  admitPageNavigationKeyV1,
  admitPresentationEscapeKeyV1,
  documentForPageNavigationV1,
  navigatePageIdV1,
  pageNavigationElementFactsV1,
  resolveSelectedPageIdV1,
  type PageNavigationCommandV1,
} from '../../../lib/board/page-navigation';
import { adaptSnapshotToPageRenderV2 } from '../../../lib/board/page-render-adapter';
import {
  resolvePageDisplayModeV1,
  type PageViewportClassV1,
} from '../../../lib/board/page-display-mode.controller';
import type { PageDisplayModeV1 } from '../../../lib/board/page-display-mode.types';
import {
  createPresentationLifecycleStateV1,
  presentationSettlementIsCurrentV1,
  reducePresentationLifecycleV1,
  type PresentationLifecycleEventV1,
  type PresentationLifecycleIdentityV1,
} from '../../../lib/board/presentation-mode.controller';
import styles from './board.module.css';

function ArtifactLoading() {
  const { t } = useI18n();
  return (
    <div className="artifact-fallback" role="status">
      {t('board.artifactPreparing')}
    </div>
  );
}

const IsolatedArtifactHost = dynamic(
  () => import('@sceneboard/board-ui/artifact').then((module) => module.ArtifactHost),
  { ssr: false, loading: () => <ArtifactLoading /> },
);

type HitlRendererInput = Parameters<RendererComponentV1<'content.hitl'>>[0];

function ActiveHitlBlock({
  api,
  renderer,
  mode,
  routeEpoch,
  onActiveChange,
}: {
  api: BoardApiClient;
  renderer: HitlRendererInput;
  mode: HitlInteractionControllerV1['mode'];
  routeEpoch: string;
  onActiveChange: (source: string, active: boolean) => void;
}) {
  const { t } = useI18n();
  const { node, context } = renderer;
  const current = context.hitl.find((item) => item.hitlRequestId === node.hitlRequestId);
  if (current === undefined)
    return (
      <div className="scene-fallback" role="alert">
        {t('board.interactionUnavailable')}
      </div>
    );
  return (
    <BoundHitlBlock
      api={api}
      nodeId={node.id}
      boardId={context.boardId}
      expectedRevisionId={context.revision.revisionId}
      interaction={current}
      mode={mode}
      routeEpoch={routeEpoch}
      activityKey={`${routeEpoch}:${current.hitlRequestId}`}
      onActiveChange={onActiveChange}
    />
  );
}

const BoundHitlBlock = memo(
  function BoundHitlBlock({
    api,
    nodeId,
    boardId,
    expectedRevisionId,
    interaction,
    mode,
    routeEpoch,
    activityKey,
    onActiveChange,
  }: {
    api: BoardApiClient;
    nodeId: string;
    boardId: HitlRendererInput['context']['boardId'];
    expectedRevisionId: HitlRendererInput['context']['revision']['revisionId'];
    interaction: HitlRendererInput['context']['hitl'][number];
    mode: HitlInteractionControllerV1['mode'];
    routeEpoch: string;
    activityKey: string;
    onActiveChange: (source: string, active: boolean) => void;
  }) {
    const bound = useHitlInteractionController({
      api,
      boardId,
      expectedRevisionId,
      interaction,
      mode,
      routeEpoch,
    });
    useEffect(() => {
      const active = interaction.state === 'open';
      onActiveChange(activityKey, active);
      return () => {
        if (active) onActiveChange(activityKey, false);
      };
    }, [activityKey, interaction.state, onActiveChange]);
    return (
      <HitlBlock
        key={`${routeEpoch}:${mode}:${interaction.hitlRequestId}`}
        nodeId={nodeId}
        boardId={boardId}
        expectedRevisionId={expectedRevisionId}
        interaction={bound.interaction}
        controller={bound.controller}
      />
    );
  },
  (previous, next) =>
    previous.api === next.api &&
    previous.nodeId === next.nodeId &&
    previous.boardId === next.boardId &&
    previous.expectedRevisionId === next.expectedRevisionId &&
    previous.mode === next.mode &&
    previous.routeEpoch === next.routeEpoch &&
    previous.activityKey === next.activityKey &&
    previous.onActiveChange === next.onActiveChange &&
    previous.interaction.hitlRequestId === next.interaction.hitlRequestId &&
    previous.interaction.stateUpdatedAt === next.interaction.stateUpdatedAt,
);

export function BoardClient({ boardId }: { boardId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const session = useBoardSession(boardId);
  const [selectedTabs, setSelectedTabs] = useState<Record<string, string>>({});
  const [artifactViewMode, setArtifactViewMode] = useState<ArtifactViewModeV1>('fit-height');
  const [artifactStopSignal, setArtifactStopSignal] = useState(0);
  const [artifactViews, dispatchArtifactView] = useReducer(
    reduceArtifactViewRegistryV1,
    undefined,
    createArtifactViewRegistryV1,
  );
  const [drawingView, setDrawingView] = useState<DrawingViewStateV1>({
    nodeId: '',
    scale: null,
    canReset: false,
  });
  const [drawingResetSignal, setDrawingResetSignal] = useState(0);
  const [api] = useState(() => new BoardApiClient(authSessionClient().sharedCoordinator()));
  const [artifactLoad] = useState<ArtifactLoadPortV1>(() => {
    return {
      async readMetadata(input) {
        const result = await api.getArtifact(input.boardId, input.artifact, input.signal);
        if (result.kind !== 'ok') throw new TypeError('artifact metadata request failed safely');
        return { manifest: result.value.manifest, runtime: result.value.runtime };
      },
      async readPackage(input) {
        const result = await api.getArtifactPackage(input.boardId, input.artifact, input.signal);
        if (result.kind !== 'ok') throw new TypeError('artifact package request failed safely');
        return result.value.bytes;
      },
    };
  });
  const [selectedPageId, setSelectedPageId] = useState<PageId | null>(null);
  const [viewportClass, setViewportClass] = useState<PageViewportClassV1>('desktop');
  const [pageDisplaySelection, setPageDisplaySelection] = useState<{
    routeBoardId: string;
    mode: PageDisplayModeV1;
  } | null>(null);
  const [pageAnnouncement, setPageAnnouncement] = useState('');
  const [presentationState, setPresentationState] = useState(createPresentationLifecycleStateV1);
  const [presentationActivitySignal, setPresentationActivitySignal] = useState(0);
  const [artifactCaptureActive, setArtifactCaptureActive] = useState(false);
  const [hitlInteractionActive, setHitlInteractionActive] = useState(false);
  const [moveAvailable, setMoveAvailable] = useState(false);
  const [moveToggle, setMoveToggle] = useState(false);
  const [moveCaptureActive, setMoveCaptureActive] = useState(false);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const pageElementEpochRef = useRef(0);
  const presentationRequestEpochRef = useRef(0);
  const presentationStateRef = useRef(presentationState);
  const presentationPageRef = useRef<HTMLDivElement | null>(null);
  const presentationInvokerRef = useRef<HTMLButtonElement | null>(null);
  const presentationButtonRef = useRef<HTMLButtonElement | null>(null);
  const lifecycleRouteRef = useRef<string | null>(null);
  const pageIdentityRef = useRef<string | null>(null);
  const captureSourcesRef = useRef(new Set<string>());
  const hitlSourcesRef = useRef(new Set<string>());
  const revisionId = session.visibleSnapshot?.revision.revisionId ?? null;
  const navigationDocument =
    session.visibleSnapshot === null ? null : documentForPageNavigationV1(session.visibleSnapshot);
  const resolvedPageId =
    navigationDocument === null
      ? null
      : resolveSelectedPageIdV1(navigationDocument, selectedPageId);
  const resolvedPageIndex =
    navigationDocument === null || resolvedPageId === null
      ? -1
      : navigationDocument.pages.findIndex((page) => page.pageId === resolvedPageId);
  const pageDisplayMode = resolvePageDisplayModeV1({
    routeBoardId: boardId,
    viewportClass,
    userSelection:
      pageDisplaySelection?.routeBoardId === boardId ? pageDisplaySelection.mode : null,
  });
  const presentationActive =
    presentationState.mode !== 'inactive' &&
    presentationState.identity?.boardId === boardId &&
    presentationState.identity.revisionId === revisionId;

  const transitionPresentation = useCallback((event: PresentationLifecycleEventV1) => {
    const next = reducePresentationLifecycleV1(presentationStateRef.current, event);
    presentationStateRef.current = next;
    setPresentationState(next);
  }, []);
  const bindPageStage = useCallback((element: HTMLDivElement | null) => {
    if (pageScrollRef.current !== element) pageElementEpochRef.current += 1;
    pageScrollRef.current = element;
  }, []);
  const restorePresentationFocus = useCallback(() => {
    const invoker = presentationInvokerRef.current;
    if (invoker?.isConnected) {
      invoker.focus();
      return;
    }
    const page = pageScrollRef.current;
    if (page?.isConnected) {
      page.focus();
      return;
    }
    document.querySelector<HTMLElement>('.board-topbar h2')?.focus();
  }, []);
  const exitPresentation = useCallback(
    (restoreFocus = true) => {
      presentationRequestEpochRef.current += 1;
      const ownedPage = presentationPageRef.current;
      presentationPageRef.current = null;
      transitionPresentation({ type: 'invalidate' });
      if (ownedPage !== null && document.fullscreenElement === ownedPage) {
        void document.exitFullscreen().catch(() => undefined);
      }
      if (restoreFocus) requestAnimationFrame(restorePresentationFocus);
    },
    [restorePresentationFocus, transitionPresentation],
  );
  const enterPresentation = useCallback(() => {
    const page = pageScrollRef.current;
    if (page === null || revisionId === null) return;
    const identity: PresentationLifecycleIdentityV1 = {
      boardId,
      revisionId,
      routeEpoch: `${boardId}:${revisionId}`,
      pageElementEpoch: pageElementEpochRef.current,
      requestEpoch: presentationRequestEpochRef.current + 1,
    };
    presentationRequestEpochRef.current = identity.requestEpoch;
    presentationPageRef.current = page;
    presentationInvokerRef.current = presentationButtonRef.current;
    transitionPresentation({ type: 'enter', identity });
    const current = () =>
      presentationSettlementIsCurrentV1({
        expected: identity,
        current: presentationStateRef.current.identity,
        capturedPage: page,
        currentPage: pageScrollRef.current,
      });
    const fallback = () => {
      if (current()) transitionPresentation({ type: 'fallback-focus', identity });
    };
    if (document.fullscreenElement !== null && document.fullscreenElement !== page) {
      fallback();
      return;
    }
    if (typeof page.requestFullscreen !== 'function') {
      fallback();
      return;
    }
    let request: Promise<void>;
    try {
      request = page.requestFullscreen();
    } catch {
      fallback();
      return;
    }
    void request.then(() => {
      if (!current()) {
        if (
          document.fullscreenElement === page &&
          presentationStateRef.current.mode !== 'fullscreen'
        )
          void document.exitFullscreen().catch(() => undefined);
        return;
      }
      if (document.fullscreenElement === page)
        transitionPresentation({ type: 'fullscreen-entered', identity });
      else fallback();
    }, fallback);
  }, [boardId, revisionId, transitionPresentation]);

  const setCaptureActive = useCallback((source: string, active: boolean) => {
    if (active) captureSourcesRef.current.add(source);
    else captureSourcesRef.current.delete(source);
    setArtifactCaptureActive(captureSourcesRef.current.size > 0);
  }, []);
  const setHitlActive = useCallback((source: string, active: boolean) => {
    if (active) hitlSourcesRef.current.add(source);
    else hitlSourcesRef.current.delete(source);
    setHitlInteractionActive(hitlSourcesRef.current.size > 0);
  }, []);

  const announceAndResetPage = useCallback(
    (pageId: PageId) => {
      if (navigationDocument === null) return;
      const index = navigationDocument.pages.findIndex((page) => page.pageId === pageId);
      if (index < 0) return;
      pageScrollRef.current?.scrollTo({
        top: 0,
        behavior: 'instant' as ScrollBehavior,
      });
      setPageAnnouncement(
        t('presentation.pageAnnouncement', {
          current: index + 1,
          total: navigationDocument.pages.length,
        }),
      );
    },
    [navigationDocument, t],
  );

  const selectPage = useCallback(
    (command: PageNavigationCommandV1): boolean => {
      if (
        navigationDocument === null ||
        resolvedPageId === null ||
        session.visibleSnapshot === null
      )
        return false;
      const nextPageId = navigatePageIdV1(navigationDocument, resolvedPageId, command);
      if (nextPageId === resolvedPageId) return false;
      pageIdentityRef.current = `${boardId}:${session.visibleSnapshot.revision.revisionId}:${nextPageId}`;
      setMoveToggle(false);
      setSelectedPageId(nextPageId);
      announceAndResetPage(nextPageId);
      return true;
    },
    [announceAndResetPage, boardId, navigationDocument, resolvedPageId, session.visibleSnapshot],
  );

  useEffect(() => setSelectedTabs({}), [boardId, revisionId]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const updateViewportClass = () => setViewportClass(media.matches ? 'mobile' : 'desktop');
    updateViewportClass();
    media.addEventListener('change', updateViewportClass);
    return () => media.removeEventListener('change', updateViewportClass);
  }, []);
  useEffect(() => {
    dispatchArtifactView({ type: 'clear' });
    setDrawingView({ nodeId: '', scale: null, canReset: false });
    captureSourcesRef.current.clear();
    hitlSourcesRef.current.clear();
    setArtifactCaptureActive(false);
    setHitlInteractionActive(false);
    setMoveAvailable(false);
    setMoveToggle(false);
    setMoveCaptureActive(false);
  }, [boardId]);
  useEffect(() => {
    if (resolvedPageId === null || session.visibleSnapshot === null) return;
    setSelectedPageId((current) => (current === resolvedPageId ? current : resolvedPageId));
    const identity = `${boardId}:${session.visibleSnapshot.revision.revisionId}:${resolvedPageId}`;
    if (pageIdentityRef.current === identity) return;
    pageIdentityRef.current = identity;
    setMoveToggle(false);
    announceAndResetPage(resolvedPageId);
  }, [announceAndResetPage, boardId, resolvedPageId, session.visibleSnapshot]);
  useEffect(() => {
    const routeIdentity = `${boardId}:${revisionId ?? 'pending'}`;
    if (
      lifecycleRouteRef.current !== null &&
      lifecycleRouteRef.current !== routeIdentity &&
      presentationStateRef.current.mode !== 'inactive'
    )
      exitPresentation(false);
    lifecycleRouteRef.current = routeIdentity;
  }, [boardId, exitPresentation, revisionId]);
  useEffect(() => {
    const synchronizeFullscreen = () => {
      const current = presentationStateRef.current;
      const identity = current.identity;
      const page = presentationPageRef.current;
      if (
        identity === null ||
        page === null ||
        !presentationSettlementIsCurrentV1({
          expected: identity,
          current: identity,
          capturedPage: page,
          currentPage: pageScrollRef.current,
        })
      )
        return;
      if (document.fullscreenElement === page) {
        return;
      }
      if (current.mode === 'fullscreen') {
        presentationRequestEpochRef.current += 1;
        presentationPageRef.current = null;
        transitionPresentation({ type: 'matching-exit', identity });
        requestAnimationFrame(restorePresentationFocus);
      }
    };
    const exitFocusOnVisibilityLoss = () => {
      if (document.visibilityState === 'hidden' && presentationStateRef.current.mode === 'focus')
        exitPresentation(false);
    };
    document.addEventListener('fullscreenchange', synchronizeFullscreen);
    document.addEventListener('visibilitychange', exitFocusOnVisibilityLoss);
    return () => {
      document.removeEventListener('fullscreenchange', synchronizeFullscreen);
      document.removeEventListener('visibilitychange', exitFocusOnVisibilityLoss);
    };
  }, [exitPresentation, restorePresentationFocus, transitionPresentation]);
  useEffect(
    () => () => {
      presentationRequestEpochRef.current += 1;
      const ownedPage = presentationPageRef.current;
      presentationPageRef.current = null;
      presentationStateRef.current = createPresentationLifecycleStateV1();
      if (ownedPage !== null && document.fullscreenElement === ownedPage)
        void document.exitFullscreen().catch(() => undefined);
    },
    [],
  );
  useEffect(() => {
    const navigatePage = (event: KeyboardEvent) => {
      const admission = {
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        target: pageNavigationElementFactsV1(event.target),
        composedPath: event
          .composedPath()
          .map(pageNavigationElementFactsV1)
          .filter((fact) => fact !== null),
        hitlInteractionActive,
        artifactCaptureActive,
        moveCaptureActive,
      };
      if (
        presentationStateRef.current.mode === 'focus' &&
        admitPresentationEscapeKeyV1(admission)
      ) {
        event.preventDefault();
        exitPresentation();
        return;
      }
      const command = admitPageNavigationKeyV1(admission);
      if (command !== null && selectPage(command)) {
        event.preventDefault();
        setPresentationActivitySignal((value) => value + 1);
      }
    };

    window.addEventListener('keydown', navigatePage);
    return () => window.removeEventListener('keydown', navigatePage);
  }, [
    artifactCaptureActive,
    exitPresentation,
    hitlInteractionActive,
    moveCaptureActive,
    selectPage,
  ]);

  if (session.phase === 'loading' || (session.state === null && session.error === null)) {
    return (
      <section className="route-state" role="status">
        <span className="spinner" />
        {t('board.loadingScene')}
      </section>
    );
  }
  if (session.error !== null || session.state === null || session.visibleSnapshot === null) {
    return (
      <BoardStatePanel
        error={
          session.error ?? {
            kind: 'unknown',
            message: t('board.sceneUnavailable'),
            retryable: true,
          }
        }
        onRetry={() => void session.retry()}
      />
    );
  }
  const { state, visibleSnapshot } = session;
  if (resolvedPageId === null || navigationDocument === null || resolvedPageIndex < 0) {
    return (
      <BoardStatePanel
        error={{
          kind: 'corrupt',
          message: t('board.sceneUnavailable'),
          retryable: false,
        }}
        onRetry={() => void session.retry()}
      />
    );
  }
  let pageRender;
  try {
    pageRender = adaptSnapshotToPageRenderV2(visibleSnapshot, resolvedPageId);
  } catch {
    return (
      <BoardStatePanel
        error={{
          kind: 'corrupt',
          message: t('board.sceneUnavailable'),
          retryable: false,
        }}
        onRetry={() => void session.retry()}
      />
    );
  }
  const runtimeOrigin = process.env.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN ?? '';
  const routeEpoch = `${boardId}:${visibleSnapshot.revision.revisionId}`;
  const artifactRouteEpoch = boardId;
  const hitlMode: HitlInteractionControllerV1['mode'] =
    state.mode.kind === 'history' ? 'history' : 'live';
  const unplacedOpenHitl =
    state.mode.kind === 'live' ? selectUnplacedOpenHitlV1(visibleSnapshot) : [];
  const renderArtifact: RendererComponentV1<'content.artifact'> = ({ node, context }) => {
    const runtime = context.artifacts.find(
      (item) =>
        item.artifact.artifactId === node.artifact.artifactId &&
        item.artifact.versionId === node.artifact.versionId,
    );
    if (runtime === undefined)
      return (
        <div className="artifact-fallback" role="alert">
          {t('board.artifactUnavailable')}
        </div>
      );
    const incarnationKey = `${artifactRouteEpoch}:${node.id}:${node.artifact.artifactId}:${node.artifact.versionId}`;
    return (
      <IsolatedArtifactHost
        key={incarnationKey}
        boardId={context.boardId}
        artifact={node.artifact}
        runtime={runtime}
        runtimeOrigin={runtimeOrigin}
        routeEpoch={artifactRouteEpoch}
        hostInstanceId={node.id}
        incarnationKey={incarnationKey}
        snapshotWatermark={context.lastEventSequence}
        load={artifactLoad}
        viewMode={artifactViewMode}
        showStopControl={false}
        stopSignal={artifactStopSignal}
        onViewStateChange={(event) => dispatchArtifactView({ type: 'event', event })}
        onCaptureActiveChange={(active) => setCaptureActive(incarnationKey, active)}
        resetCommand={artifactViews.resetCommand}
      />
    );
  };
  const renderHitl: RendererComponentV1<'content.hitl'> = (renderer) => (
    <ActiveHitlBlock
      api={api}
      renderer={renderer}
      mode={hitlMode}
      routeEpoch={routeEpoch}
      onActiveChange={setHitlActive}
    />
  );
  const onDrawingViewStateChange = (next: DrawingViewStateV1) => {
    setDrawingView((current) =>
      current.nodeId === next.nodeId &&
      current.scale === next.scale &&
      current.canReset === next.canReset
        ? current
        : next,
    );
  };
  const rootIsDrawing = pageRender.page.scene.root?.type === 'content.drawing';
  const rootCanvas =
    pageRender.page.scene.root?.type === 'layout.canvas'
      ? {
          width: pageRender.page.scene.root.width,
          height: pageRender.page.scene.root.height,
        }
      : null;
  const selectedZoom = rootIsDrawing ? drawingView.scale : selectedArtifactZoomV1(artifactViews);
  const canResetView = rootIsDrawing ? drawingView.canReset : canResetArtifactViewV1(artifactViews);
  const resetView = () => {
    dispatchArtifactView({ type: 'reset' });
    setDrawingResetSignal((value) => value + 1);
  };
  const selectPageDisplayMode = (mode: PageDisplayModeV1) => {
    setPageDisplaySelection({ routeBoardId: boardId, mode });
    setMoveToggle(false);
  };
  const pageDisplayControls = (
    <div className="board-page-display-actions">
      <PageDisplayModeControls value={pageDisplayMode} onChange={selectPageDisplayMode} />
      <PageMoveModeControls
        available={moveAvailable}
        active={moveToggle && moveAvailable}
        onChange={setMoveToggle}
      />
      <PresentationModeControls
        active={presentationActive}
        disabled={presentationState.mode === 'requesting'}
        buttonRef={presentationButtonRef}
        onEnter={enterPresentation}
        onExit={exitPresentation}
      />
    </div>
  );
  const chromeSlots: MobileBoardDrawerSlotsV1 = {
    boardIdentity: (
      <BoardIdentitySlot title={session.title} state={state} onRename={session.rename} />
    ),
    pageDisplay: pageDisplayControls,
    history: (
      <BoardHistorySlot
        state={state}
        liveUpdated={session.liveUpdated}
        viewMode={artifactViewMode}
        onViewModeChange={setArtifactViewMode}
        artifactZoom={selectedZoom}
        canResetArtifactView={canResetView}
        onResetArtifactView={resetView}
        onPrevious={session.previous}
        onNext={session.next}
        onLatest={() => void session.latest()}
      />
    ),
    status: (
      <StatusRail
        snapshot={visibleSnapshot}
        presence={state.presence}
        onStopRendering={() => setArtifactStopSignal((value) => value + 1)}
      />
    ),
    connections: (
      <BoardConnectionsSlot
        state={state}
        pairingControl={
          <BoardPairingControl api={api} boardId={boardId} boardTitle={session.title} />
        }
      />
    ),
    ownerAdmin: (
      <BoardArchiveControl
        api={api}
        boardId={boardId}
        boardTitle={session.title}
        onArchived={() => router.replace('/boards')}
      />
    ),
  };
  const navigationNotice = state.navigationError ? (
    <div className="notice notice-error" role="alert">
      {state.navigationError.message}
    </div>
  ) : null;
  return (
    <section
      className={`board-workspace ${styles.workspace} ${presentationActive ? styles.presenting : ''} ${state.mode.kind === 'history' ? 'is-history' : ''}`}
    >
      <ResponsiveBoardChrome
        slots={chromeSlots}
        routeKey={`${boardId}:${visibleSnapshot.revision.revisionId}`}
        presentationActive={presentationActive}
        notice={navigationNotice}
        surfaceClassName={styles.surface ?? ''}
      >
        <PresentationStage
          stageRef={bindPageStage}
          mode={pageDisplayMode}
          canvasSize={rootCanvas}
          presentationActive={presentationActive}
          moveToggle={moveToggle}
          moveIdentity={`${boardId}:${visibleSnapshot.revision.revisionId}:${resolvedPageId}`}
          onMoveAvailabilityChange={setMoveAvailable}
          onMoveCaptureActiveChange={setMoveCaptureActive}
          label={t('board.sceneCanvas')}
          toolbar={
            <PageNavigationControls
              current={resolvedPageIndex + 1}
              total={navigationDocument.pages.length}
              previousLabel={t('presentation.previousPage')}
              nextLabel={t('presentation.nextPage')}
              statusLabel={t('presentation.pageNavigation')}
              onPrevious={() => selectPage('previous')}
              onNext={() => selectPage('next')}
            />
          }
          overlay={
            <PresentationControlOverlay
              active={presentationActive}
              activitySignal={presentationActivitySignal}
              current={resolvedPageIndex + 1}
              total={navigationDocument.pages.length}
              dialogOrMenuOpen={false}
              hitlInteractionActive={hitlInteractionActive}
              artifactCaptureActive={artifactCaptureActive}
              moveCaptureActive={moveCaptureActive}
              additionalControls={
                <>
                  <PageDisplayModeControls
                    value={pageDisplayMode}
                    onChange={selectPageDisplayMode}
                  />
                  <PageMoveModeControls
                    available={moveAvailable}
                    active={moveToggle && moveAvailable}
                    onChange={setMoveToggle}
                  />
                </>
              }
              onPrevious={() => {
                if (selectPage('previous')) setPresentationActivitySignal((value) => value + 1);
              }}
              onNext={() => {
                if (selectPage('next')) setPresentationActivitySignal((value) => value + 1);
              }}
              onExit={exitPresentation}
            />
          }
        >
          <span className="visually-hidden" aria-live="polite" aria-atomic="true">
            {pageAnnouncement}
          </span>
          <BoardRenderer
            key={`${boardId}:${visibleSnapshot.revision.revisionId}:${resolvedPageId}`}
            page={pageRender.page}
            context={pageRender.context}
            emptyLabel=""
            selectedTabs={selectedTabs}
            onSelectTab={(nodeId, tabId) =>
              setSelectedTabs((current) => ({ ...current, [nodeId]: tabId }))
            }
            renderArtifact={renderArtifact}
            renderHitl={renderHitl}
            drawingView={{
              mode: artifactViewMode,
              resetSignal: drawingResetSignal,
              onStateChange: onDrawingViewStateChange,
              onCaptureActiveChange: (active) =>
                setCaptureActive(`drawing:${resolvedPageId}`, active),
            }}
          />
          {unplacedOpenHitl.length > 0 && (
            <HitlDecisionWorkspace
              label={t('board.interactions')}
              preferExpanded={shouldPreferExpandedDecisionWorkspaceV1(unplacedOpenHitl)}
            >
              {unplacedOpenHitl.map((interaction) => (
                <BoundHitlBlock
                  key={`${routeEpoch}:automatic:${interaction.hitlRequestId}`}
                  api={api}
                  nodeId={`automatic-hitl-${interaction.hitlRequestId}`}
                  boardId={visibleSnapshot.boardId}
                  expectedRevisionId={visibleSnapshot.revision.revisionId}
                  interaction={interaction}
                  mode={hitlMode}
                  routeEpoch={routeEpoch}
                  activityKey={`${routeEpoch}:automatic:${interaction.hitlRequestId}`}
                  onActiveChange={setHitlActive}
                />
              ))}
            </HitlDecisionWorkspace>
          )}
        </PresentationStage>
      </ResponsiveBoardChrome>
    </section>
  );
}
