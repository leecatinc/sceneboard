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
import { BoardTopBar } from '../../../components/board/BoardTopBar';
import { BoardArchiveControl } from '../../../components/board/BoardArchiveControl';
import { PageNavigationControls } from '../../../components/board/PageNavigationControls';
import { PageDisplayModeControls } from '../../../components/board/PageDisplayModeControls';
import { PresentationStage } from '../../../components/board/PresentationStage';
import { HitlDecisionWorkspace } from '../../../components/board/HitlDecisionWorkspace';
import { StatusRail } from '../../../components/board/StatusRail';
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
  const [artifactCaptureActive, setArtifactCaptureActive] = useState(false);
  const [hitlInteractionActive, setHitlInteractionActive] = useState(false);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
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
  const moveCaptureActive = false;
  const pageDisplayMode = resolvePageDisplayModeV1({
    routeBoardId: boardId,
    viewportClass,
    userSelection:
      pageDisplaySelection?.routeBoardId === boardId ? pageDisplaySelection.mode : null,
  });

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
  }, [boardId]);
  useEffect(() => {
    if (resolvedPageId === null || session.visibleSnapshot === null) return;
    setSelectedPageId((current) => (current === resolvedPageId ? current : resolvedPageId));
    const identity = `${boardId}:${session.visibleSnapshot.revision.revisionId}:${resolvedPageId}`;
    if (pageIdentityRef.current === identity) return;
    pageIdentityRef.current = identity;
    announceAndResetPage(resolvedPageId);
  }, [announceAndResetPage, boardId, resolvedPageId, session.visibleSnapshot]);
  useEffect(() => {
    const navigatePage = (event: KeyboardEvent) => {
      const command = admitPageNavigationKeyV1({
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
      });
      if (command !== null && selectPage(command)) event.preventDefault();
    };

    window.addEventListener('keydown', navigatePage);
    return () => window.removeEventListener('keydown', navigatePage);
  }, [artifactCaptureActive, hitlInteractionActive, moveCaptureActive, selectPage]);

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
  return (
    <section
      className={`board-workspace ${styles.workspace} ${state.mode.kind === 'history' ? 'is-history' : ''}`}
    >
      <BoardTopBar
        title={session.title}
        state={state}
        liveUpdated={session.liveUpdated}
        pairingControl={
          <BoardPairingControl api={api} boardId={boardId} boardTitle={session.title} />
        }
        archiveControl={
          <BoardArchiveControl
            api={api}
            boardId={boardId}
            boardTitle={session.title}
            onArchived={() => router.replace('/boards')}
          />
        }
        viewMode={artifactViewMode}
        onViewModeChange={setArtifactViewMode}
        artifactZoom={selectedZoom}
        canResetArtifactView={canResetView}
        onResetArtifactView={resetView}
        onRename={session.rename}
        onPrevious={session.previous}
        onNext={session.next}
        onLatest={() => void session.latest()}
      />
      {state.navigationError && (
        <div className="notice notice-error" role="alert">
          {state.navigationError.message}
        </div>
      )}
      <div className={`board-surface ${styles.surface}`}>
        <PresentationStage
          stageRef={pageScrollRef}
          mode={pageDisplayMode}
          canvasSize={rootCanvas}
          label={t('board.sceneCanvas')}
          toolbar={
            <>
              <PageNavigationControls
                current={resolvedPageIndex + 1}
                total={navigationDocument.pages.length}
                previousLabel={t('presentation.previousPage')}
                nextLabel={t('presentation.nextPage')}
                statusLabel={t('presentation.pageNavigation')}
                onPrevious={() => selectPage('previous')}
                onNext={() => selectPage('next')}
              />
              <PageDisplayModeControls
                value={pageDisplayMode}
                onChange={(mode) => setPageDisplaySelection({ routeBoardId: boardId, mode })}
              />
            </>
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
        <StatusRail
          snapshot={visibleSnapshot}
          presence={state.presence}
          onStopRendering={() => setArtifactStopSignal((value) => value + 1)}
        />
      </div>
    </section>
  );
}
