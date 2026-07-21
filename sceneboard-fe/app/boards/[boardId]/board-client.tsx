'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { memo, useEffect, useReducer, useState } from 'react';
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

const PAGE_NAVIGATION_TARGETS = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
].join(',');

function isEditingTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest(PAGE_NAVIGATION_TARGETS) !== null;
}

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
}: {
  api: BoardApiClient;
  renderer: HitlRendererInput;
  mode: HitlInteractionControllerV1['mode'];
  routeEpoch: string;
}) {
  const { t } = useI18n();
  const { node, context } = renderer;
  const current = context.snapshot.hitl.find((item) => item.hitlRequestId === node.hitlRequestId);
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
      boardId={context.snapshot.boardId}
      expectedRevisionId={context.snapshot.revision.revisionId}
      interaction={current}
      mode={mode}
      routeEpoch={routeEpoch}
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
  }: {
    api: BoardApiClient;
    nodeId: string;
    boardId: HitlRendererInput['context']['snapshot']['boardId'];
    expectedRevisionId: HitlRendererInput['context']['snapshot']['revision']['revisionId'];
    interaction: HitlRendererInput['context']['snapshot']['hitl'][number];
    mode: HitlInteractionControllerV1['mode'];
    routeEpoch: string;
  }) {
    const bound = useHitlInteractionController({
      api,
      boardId,
      expectedRevisionId,
      interaction,
      mode,
      routeEpoch,
    });
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
  const revisionId = session.visibleSnapshot?.revision.revisionId ?? null;
  const pageTabs =
    session.visibleSnapshot?.scene.root?.type === 'layout.tabs'
      ? session.visibleSnapshot.scene.root
      : null;

  useEffect(() => setSelectedTabs({}), [boardId, revisionId]);
  useEffect(() => dispatchArtifactView({ type: 'clear' }), [boardId]);
  useEffect(() => setDrawingView({ nodeId: '', scale: null, canReset: false }), [boardId]);
  useEffect(() => {
    if (pageTabs === null) return undefined;
    const navigatePage = (event: KeyboardEvent) => {
      const direction =
        event.key === 'ArrowRight' || event.key === 'PageDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'PageUp'
            ? -1
            : 0;
      if (
        direction === 0 ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditingTarget(event.target) ||
        document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]') !== null
      )
        return;

      event.preventDefault();
      setSelectedTabs((current) => {
        const selectedTabId = current[pageTabs.id] ?? pageTabs.activeTabId;
        const selectedIndex = pageTabs.tabs.findIndex((tab) => tab.tabId === selectedTabId);
        const nextIndex = Math.max(0, selectedIndex) + direction;
        const nextTab = pageTabs.tabs[nextIndex];
        if (nextTab === undefined) return current;
        return { ...current, [pageTabs.id]: nextTab.tabId };
      });
    };

    window.addEventListener('keydown', navigatePage);
    return () => window.removeEventListener('keydown', navigatePage);
  }, [pageTabs]);

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
  const runtimeOrigin = process.env.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN ?? '';
  const routeEpoch = `${boardId}:${visibleSnapshot.revision.revisionId}`;
  const artifactRouteEpoch = boardId;
  const hitlMode: HitlInteractionControllerV1['mode'] =
    state.mode.kind === 'history' ? 'history' : 'live';
  const unplacedOpenHitl =
    state.mode.kind === 'live' ? selectUnplacedOpenHitlV1(visibleSnapshot) : [];
  const renderArtifact: RendererComponentV1<'content.artifact'> = ({ node, context }) => {
    const runtime = context.snapshot.artifacts.find(
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
        boardId={context.snapshot.boardId}
        artifact={node.artifact}
        runtime={runtime}
        runtimeOrigin={runtimeOrigin}
        routeEpoch={artifactRouteEpoch}
        hostInstanceId={node.id}
        incarnationKey={incarnationKey}
        snapshotWatermark={context.snapshot.lastEventSequence}
        load={artifactLoad}
        viewMode={artifactViewMode}
        showStopControl={false}
        stopSignal={artifactStopSignal}
        onViewStateChange={(event) => dispatchArtifactView({ type: 'event', event })}
        resetCommand={artifactViews.resetCommand}
      />
    );
  };
  const renderHitl: RendererComponentV1<'content.hitl'> = (renderer) => (
    <ActiveHitlBlock api={api} renderer={renderer} mode={hitlMode} routeEpoch={routeEpoch} />
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
  const rootIsDrawing = visibleSnapshot.scene.root?.type === 'content.drawing';
  const selectedZoom = rootIsDrawing ? drawingView.scale : selectedArtifactZoomV1(artifactViews);
  const canResetView = rootIsDrawing ? drawingView.canReset : canResetArtifactViewV1(artifactViews);
  const resetView = () => {
    dispatchArtifactView({ type: 'reset' });
    setDrawingResetSignal((value) => value + 1);
  };
  return (
    <section className={`board-workspace ${state.mode.kind === 'history' ? 'is-history' : ''}`}>
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
      <div className="board-surface">
        <div className="scene-surface" aria-label={t('board.sceneCanvas')}>
          <BoardRenderer
            snapshot={visibleSnapshot}
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
                />
              ))}
            </HitlDecisionWorkspace>
          )}
        </div>
        <StatusRail
          snapshot={visibleSnapshot}
          presence={state.presence}
          onStopRendering={() => setArtifactStopSignal((value) => value + 1)}
        />
      </div>
    </section>
  );
}
