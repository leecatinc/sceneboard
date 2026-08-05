'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  BoardNodeV1,
  BoardSessionAccessV1,
  PageId,
  PublicPresentationSessionSummaryV1,
  PublicPresentationSnapshotV1,
} from '@sceneboard/board-schema';
import {
  BoardRenderer,
  type DrawingViewStateV1,
  type RendererComponentV1,
} from '@sceneboard/board-ui/renderer';
import type {
  ArtifactLoadPortV1,
  ArtifactPresentationPageChangeEventV1,
  ArtifactViewModeV1,
} from '@sceneboard/board-ui/artifact';
import { HitlBlock, type HitlInteractionControllerV1 } from '@sceneboard/board-ui/interaction';

import { BoardStatePanel } from '../../../components/board/BoardStatePanel';
import { Brand } from '../../../components/app/Brand';
import { BoardPairingControl } from '../../../components/board/BoardPairingControl';
import { BoardImageUploadControl } from '../../../components/board/BoardImageUploadControl';
import {
  OwnerAdminControls,
  type OwnerAdminControlsHandle,
} from '../../../components/board/OwnerAdminControls';
import {
  BoardConnectionsSlot,
  BoardHistorySlot,
  BoardIdentitySlot,
} from '../../../components/board/BoardChromeSlots';
import { PageNavigationControls } from '../../../components/board/PageNavigationControls';
import { PageDisplayModeControls } from '../../../components/board/PageDisplayModeControls';
import { PageMoveModeControls } from '../../../components/board/PageMoveModeControls';
import { PresentationStage } from '../../../components/board/PresentationStage';
import type { PresentationAnnotationDeliveryV1 } from '../../../components/board/PresentationAnnotationLayer';
import { PresentationModeControls } from '../../../components/board/PresentationModeControls';
import { HitlDecisionWorkspace } from '../../../components/board/HitlDecisionWorkspace';
import { StatusRail } from '../../../components/board/StatusRail';
import { BoardUtilityRail } from '../../../components/board/BoardUtilityRail';
import { HistoryControls } from '../../../components/board/HistoryControls';
import { ResponsiveBoardChrome } from '../../../components/board/ResponsiveBoardChrome';
import type { MobileBoardDrawerSlotsV1 } from '../../../components/board/MobileBoardDrawer';
import { useBoardSession } from '../../../lib/board/use-board-session';
import { BoardApiClient } from '../../../lib/api/board-api';
import { BoardExportApi } from '../../../lib/api/board-export-api';
import { InvitationApi } from '../../../lib/api/invitation-api';
import { ShareApi } from '../../../lib/api/share-api';
import { ShareAnalyticsApi } from '../../../lib/share-analytics/share-analytics-api';
import {
  OwnerPresentationApiError,
  OwnerPresentationSessionApi,
} from '../../../lib/api/owner-presentation-session';
import { createAccountMediaResolverV1 } from '../../../lib/api/board-media-api';
import { authSessionClient } from '../../../lib/auth/session-client';
import { useHitlInteractionController } from '../../../lib/board/use-hitl-interaction-controller';
import { selectUnplacedOpenHitlV1 } from '../../../lib/board/unplaced-hitl';
import { shouldPreferExpandedDecisionWorkspaceV1 } from '../../../lib/board/hitl-decision-workspace-policy';
import { useI18n } from '../../../components/i18n/I18nProvider';
import {
  deriveBoardAffordancesV1,
  EMPTY_BOARD_SESSION_ACCESS_V1,
  lostBoardUiOperationsV1,
  sameBoardSessionAccessV1,
} from '../../../lib/board/board-capabilities';
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
import type {
  PageCanvasTransformV1,
  PageDisplayModeV1,
} from '../../../lib/board/page-display-mode.types';
import {
  createPresentationLifecycleStateV1,
  presentationSettlementIsCurrentV1,
  reducePresentationLifecycleV1,
  type PresentationLifecycleEventV1,
  type PresentationLifecycleIdentityV1,
} from '../../../lib/board/presentation-mode.controller';
import {
  presentationAnnotationPageKeyV1,
  type PresentationAnnotationStrokeV1,
} from '../../../lib/board/presentation-annotation.controller';
import {
  ownerPresentationOperationIsCurrentV1,
  type OwnerPresentationAdmissionIdentityV1,
} from '../../../lib/board/owner-presentation-operation';
import { PublicPresentationSessionDialog } from '../../s/[shareToken]/public-presentation-session-dialog';
import styles from './board.module.css';

// Keep the completed media-authoring flow available in code while its product entry point is paused.
const MEDIA_AUTHORING_UI_ENABLED = false;

function ArtifactLoading() {
  const { t } = useI18n();
  return (
    <div className="artifact-fallback" role="status">
      {t('board.artifactPreparing')}
    </div>
  );
}

// 화면(scene) 트리가 제어할 아티팩트를 포함하는지 확인한다. 네이티브 캔버스가 없는
// 아티팩트 페이지에서 아티팩트 보기 컨트롤만 노출하기 위한 콘텐츠 인식 판단에 쓰인다.
const pageRootContainsArtifactV1 = (root: BoardNodeV1 | null): boolean => {
  if (root === null) return false;
  switch (root.type) {
    case 'content.artifact':
      return true;
    case 'layout.split':
    case 'layout.grid':
    case 'layout.canvas':
      return root.children.some((child) => pageRootContainsArtifactV1(child.node));
    case 'layout.tabs':
      return root.tabs.some((tab) => pageRootContainsArtifactV1(tab.node));
    default:
      return false;
  }
};

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
  const [artifactViewMode, setArtifactViewMode] = useState<ArtifactViewModeV1>('fit-page');
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
  const [coordinator] = useState(() => authSessionClient().sharedCoordinator());
  const [api] = useState(() => new BoardApiClient(coordinator));
  const [exportApi] = useState(() => new BoardExportApi(coordinator));
  const [invitationApi] = useState(() => new InvitationApi(coordinator));
  const [shareApi] = useState(() => new ShareApi(coordinator));
  const [ownerPresentationApi] = useState(() => new OwnerPresentationSessionApi(coordinator));
  const [shareAnalyticsApi] = useState(() => new ShareAnalyticsApi(coordinator));
  const [renderedAccess, setRenderedAccess] = useState<{
    boardId: string;
    access: BoardSessionAccessV1;
  }>({ boardId, access: EMPTY_BOARD_SESSION_ACCESS_V1 });
  const [capabilityAnnouncement, setCapabilityAnnouncement] = useState<{
    epoch: number;
    message: string;
  } | null>(null);
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
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionDialogBusy, setSessionDialogBusy] = useState(false);
  const [sessionDialogError, setSessionDialogError] = useState<string | null>(null);
  const [availableSessions, setAvailableSessions] = useState<
    readonly PublicPresentationSessionSummaryV1[]
  >([]);
  const [livePresentation, setLivePresentation] = useState<PublicPresentationSnapshotV1 | null>(
    null,
  );
  const [artifactPresentationPage, setArtifactPresentationPage] = useState<{
    outerPageKey: string;
    event: ArtifactPresentationPageChangeEventV1;
  } | null>(null);
  const [artifactCaptureActive, setArtifactCaptureActive] = useState(false);
  const [hitlInteractionActive, setHitlInteractionActive] = useState(false);
  const [moveAvailable, setMoveAvailable] = useState(false);
  const [moveToggle, setMoveToggle] = useState(false);
  const [moveCaptureActive, setMoveCaptureActive] = useState(false);
  const [annotationToolbarTarget, setAnnotationToolbarTarget] = useState<HTMLElement | null>(null);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const presentationSurfaceRef = useRef<HTMLElement | null>(null);
  const pageElementEpochRef = useRef(0);
  const pageCanvasTransformRef = useRef<PageCanvasTransformV1 | null>(null);
  const presentationRequestEpochRef = useRef(0);
  const presentationStateRef = useRef(presentationState);
  const presentationPageRef = useRef<HTMLElement | null>(null);
  const presentationInvokerRef = useRef<HTMLButtonElement | null>(null);
  const presentationButtonRef = useRef<HTMLButtonElement | null>(null);
  const livePresentationRef = useRef(livePresentation);
  const pendingPresentationUpdateRef = useRef<{
    pageId: PageId;
    strokes: readonly PresentationAnnotationStrokeV1[];
    delivery: PresentationAnnotationDeliveryV1;
  } | null>(null);
  const presentationUpdateInFlightRef = useRef(false);
  const presentationUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presentationUpdateLastStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const presentationSessionOperationEpochRef = useRef(0);
  const resolvedPageIdRef = useRef<PageId | null>(null);
  const lifecycleRouteRef = useRef<string | null>(null);
  const pageIdentityRef = useRef<string | null>(null);
  const captureSourcesRef = useRef(new Set<string>());
  const hitlSourcesRef = useRef(new Set<string>());
  const ownerAdminRef = useRef<OwnerAdminControlsHandle>(null);
  const exitPresentationRef = useRef<(restoreFocus?: boolean) => void>(() => undefined);
  const capabilityAnnouncementEpochRef = useRef(0);
  const revisionId = session.visibleSnapshot?.revision.revisionId ?? null;
  livePresentationRef.current = livePresentation;
  const accessForRender =
    renderedAccess.boardId === boardId ? renderedAccess.access : EMPTY_BOARD_SESSION_ACCESS_V1;
  const affordances = useMemo(() => deriveBoardAffordancesV1(accessForRender), [accessForRender]);
  const canUseOwnerPresentation = affordances['share.manage'];
  const { closeHistory, latest: loadLatestSnapshot, sessionAccess: latestSessionAccess } = session;
  const canAdmitOwnerPresentation = deriveBoardAffordancesV1(latestSessionAccess)['share.manage'];
  const presentationSessionAdmissionRef = useRef<OwnerPresentationAdmissionIdentityV1>({
    mounted: true,
    boardId,
    revisionId,
    allowed: canAdmitOwnerPresentation,
  });
  presentationSessionAdmissionRef.current = {
    mounted: true,
    boardId,
    revisionId,
    allowed: canAdmitOwnerPresentation,
  };

  useEffect(() => {
    presentationSessionOperationEpochRef.current += 1;
  }, [boardId, revisionId]);

  useEffect(() => {
    const previousAccess =
      renderedAccess.boardId === boardId ? renderedAccess.access : EMPTY_BOARD_SESSION_ACCESS_V1;
    const nextAccess = latestSessionAccess;
    if (renderedAccess.boardId === boardId && sameBoardSessionAccessV1(previousAccess, nextAccess))
      return;
    const previousAffordances = deriveBoardAffordancesV1(previousAccess);
    const nextAffordances = deriveBoardAffordancesV1(nextAccess);
    const lost = lostBoardUiOperationsV1(previousAffordances, nextAffordances);
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (
      lost.includes('membership.manage') ||
      lost.includes('share.manage') ||
      lost.includes('analytics.read') ||
      lost.includes('export.render') ||
      lost.includes('board.archive') ||
      lost.includes('board.delete')
    )
      ownerAdminRef.current?.closeAndClearOwnerAdmin();
    if (lost.includes('share.manage')) {
      presentationSessionOperationEpochRef.current += 1;
      setSessionDialogOpen(false);
      setSessionDialogBusy(false);
      setSessionDialogError(null);
      setAvailableSessions([]);
      exitPresentationRef.current(false);
    }
    if (lost.includes('history.read')) {
      closeHistory();
      void loadLatestSnapshot(true);
    }
    setRenderedAccess({ boardId, access: nextAccess });
    if (lost.length === 0) return;
    capabilityAnnouncementEpochRef.current += 1;
    setCapabilityAnnouncement({
      epoch: capabilityAnnouncementEpochRef.current,
      message: t('board.capabilitiesChanged'),
    });
    requestAnimationFrame(() => {
      if (activeElement?.isConnected) {
        activeElement.focus();
        return;
      }
      const drawerTrigger = document.querySelector<HTMLElement>('.mobile-board-drawer-trigger');
      if (drawerTrigger?.isConnected) {
        drawerTrigger.focus();
        return;
      }
      document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
    });
  }, [boardId, closeHistory, latestSessionAccess, loadLatestSnapshot, renderedAccess, t]);
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
  resolvedPageIdRef.current = resolvedPageId;
  const outerAnnotationPageKey = [
    boardId,
    revisionId ?? 'unavailable',
    resolvedPageId ?? 'unavailable',
  ].join('\u0000');
  const annotationPageKey = presentationAnnotationPageKeyV1(
    outerAnnotationPageKey,
    artifactPresentationPage?.outerPageKey === outerAnnotationPageKey
      ? artifactPresentationPage.event
      : null,
  );
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
    pageScrollRef.current = element;
  }, []);
  const bindPresentationSurface = useCallback((element: HTMLElement | null) => {
    if (presentationSurfaceRef.current !== element) pageElementEpochRef.current += 1;
    presentationSurfaceRef.current = element;
  }, []);
  const bindPageCanvasTransform = useCallback((transform: PageCanvasTransformV1 | null) => {
    pageCanvasTransformRef.current = transform;
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
      presentationSessionOperationEpochRef.current += 1;
      const live = livePresentationRef.current;
      const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
      if (live?.role === 'presenter' && revisionId !== null && apiOrigin !== undefined)
        void ownerPresentationApi
          .end({ apiOrigin, boardId, revisionId, sessionId: live.sessionId })
          .catch(() => undefined);
      livePresentationRef.current = null;
      setLivePresentation(null);
      pendingPresentationUpdateRef.current = null;
      if (presentationUpdateTimerRef.current !== null)
        clearTimeout(presentationUpdateTimerRef.current);
      presentationUpdateTimerRef.current = null;
      presentationRequestEpochRef.current += 1;
      const ownedPage = presentationPageRef.current;
      presentationPageRef.current = null;
      transitionPresentation({ type: 'invalidate' });
      if (ownedPage !== null && document.fullscreenElement === ownedPage) {
        void document.exitFullscreen().catch(() => undefined);
      }
      if (restoreFocus) requestAnimationFrame(restorePresentationFocus);
    },
    [boardId, ownerPresentationApi, restorePresentationFocus, revisionId, transitionPresentation],
  );
  exitPresentationRef.current = exitPresentation;
  const enterPresentation = useCallback(() => {
    const page = presentationSurfaceRef.current;
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
        currentPage: presentationSurfaceRef.current,
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

  const refreshPresentationSessions = useCallback(async () => {
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (revisionId === null || apiOrigin === undefined) return;
    const operationEpoch = presentationSessionOperationEpochRef.current + 1;
    presentationSessionOperationEpochRef.current = operationEpoch;
    const expectedAdmission = { boardId, revisionId };
    const isCurrent = () =>
      ownerPresentationOperationIsCurrentV1({
        operationEpoch,
        currentOperationEpoch: presentationSessionOperationEpochRef.current,
        expected: expectedAdmission,
        current: presentationSessionAdmissionRef.current,
      });
    setSessionDialogBusy(true);
    setSessionDialogError(null);
    try {
      const result = await ownerPresentationApi.list({ apiOrigin, boardId, revisionId });
      if (isCurrent()) setAvailableSessions(result.sessions);
    } catch {
      if (isCurrent()) setSessionDialogError(t('presentation.liveSessionUnavailable'));
    } finally {
      if (isCurrent()) setSessionDialogBusy(false);
    }
  }, [boardId, ownerPresentationApi, revisionId, t]);

  const activateLivePresentation = useCallback(
    (snapshot: PublicPresentationSnapshotV1) => {
      livePresentationRef.current = snapshot;
      setLivePresentation(snapshot);
      setSessionDialogOpen(false);
      setSessionDialogError(null);
      if (snapshot.currentPageId !== resolvedPageId) setSelectedPageId(snapshot.currentPageId);
      enterPresentation();
    },
    [enterPresentation, resolvedPageId],
  );

  const startLivePresentation = useCallback(async () => {
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (revisionId === null || resolvedPageId === null || apiOrigin === undefined) return;
    const operationEpoch = presentationSessionOperationEpochRef.current + 1;
    presentationSessionOperationEpochRef.current = operationEpoch;
    const expectedAdmission = { boardId, revisionId };
    const isCurrent = () =>
      ownerPresentationOperationIsCurrentV1({
        operationEpoch,
        currentOperationEpoch: presentationSessionOperationEpochRef.current,
        expected: expectedAdmission,
        current: presentationSessionAdmissionRef.current,
      });
    setSessionDialogBusy(true);
    setSessionDialogError(null);
    try {
      const snapshot = await ownerPresentationApi.start({
        apiOrigin,
        boardId,
        revisionId,
        currentPageId: resolvedPageId,
      });
      if (!isCurrent()) {
        if (snapshot.role === 'presenter')
          void ownerPresentationApi
            .end({ apiOrigin, boardId, revisionId, sessionId: snapshot.sessionId })
            .catch(() => undefined);
        return;
      }
      activateLivePresentation(snapshot);
    } catch {
      if (isCurrent()) setSessionDialogError(t('presentation.liveSessionUnavailable'));
    } finally {
      if (isCurrent()) setSessionDialogBusy(false);
    }
  }, [activateLivePresentation, boardId, ownerPresentationApi, resolvedPageId, revisionId, t]);

  const joinLivePresentation = useCallback(
    async (sessionId: string) => {
      const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
      if (revisionId === null || apiOrigin === undefined) return;
      const operationEpoch = presentationSessionOperationEpochRef.current + 1;
      presentationSessionOperationEpochRef.current = operationEpoch;
      const expectedAdmission = { boardId, revisionId };
      const isCurrent = () =>
        ownerPresentationOperationIsCurrentV1({
          operationEpoch,
          currentOperationEpoch: presentationSessionOperationEpochRef.current,
          expected: expectedAdmission,
          current: presentationSessionAdmissionRef.current,
        });
      setSessionDialogBusy(true);
      setSessionDialogError(null);
      try {
        const snapshot = await ownerPresentationApi.get({
          apiOrigin,
          boardId,
          revisionId,
          sessionId,
        });
        if (isCurrent()) activateLivePresentation(snapshot);
      } catch {
        if (isCurrent()) {
          setSessionDialogError(t('presentation.liveSessionUnavailable'));
          await refreshPresentationSessions();
        }
      } finally {
        if (isCurrent()) setSessionDialogBusy(false);
      }
    },
    [
      activateLivePresentation,
      boardId,
      ownerPresentationApi,
      refreshPresentationSessions,
      revisionId,
      t,
    ],
  );

  const flushPresentationUpdate = useCallback(() => {
    if (presentationUpdateInFlightRef.current) return;
    const pending = pendingPresentationUpdateRef.current;
    const active = livePresentationRef.current;
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (
      pending === null ||
      active?.role !== 'presenter' ||
      revisionId === null ||
      apiOrigin === undefined
    )
      return;
    pendingPresentationUpdateRef.current = null;
    presentationUpdateInFlightRef.current = true;
    presentationUpdateLastStartedAtRef.current = performance.now();
    const update = (expectedVersion: number) =>
      ownerPresentationApi.update({
        apiOrigin,
        boardId,
        revisionId,
        sessionId: active.sessionId,
        update: {
          expectedVersion,
          currentPageId: pending.pageId,
          annotation: {
            pageId: pending.pageId,
            strokes: pending.strokes.map((stroke) => ({
              id: stroke.id,
              color: stroke.color,
              width: stroke.width === 2 || stroke.width === 8 ? stroke.width : 4,
              points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
            })),
          },
        },
      });
    void (async () => {
      try {
        let next: PublicPresentationSnapshotV1;
        try {
          next = await update(active.version);
        } catch (error) {
          if (!(error instanceof OwnerPresentationApiError) || error.status !== 409) throw error;
          const latest = await ownerPresentationApi.get({
            apiOrigin,
            boardId,
            revisionId,
            sessionId: active.sessionId,
          });
          if (latest.role !== 'presenter') throw error;
          next = await update(latest.version);
        }
        if (livePresentationRef.current?.sessionId === next.sessionId) {
          livePresentationRef.current = next;
          setLivePresentation(next);
        }
      } catch {
        setSessionDialogError(t('presentation.liveSessionUnavailable'));
      } finally {
        presentationUpdateInFlightRef.current = false;
        if (pendingPresentationUpdateRef.current !== null) {
          presentationUpdateTimerRef.current = setTimeout(() => {
            presentationUpdateTimerRef.current = null;
            flushPresentationUpdate();
          }, 125);
        }
      }
    })();
  }, [boardId, ownerPresentationApi, revisionId, t]);

  const handlePresentationStrokesChange = useCallback(
    (
      strokes: readonly PresentationAnnotationStrokeV1[],
      delivery: PresentationAnnotationDeliveryV1,
    ) => {
      const pageId = resolvedPageIdRef.current;
      if (pageId === null || livePresentationRef.current?.role !== 'presenter') return;
      pendingPresentationUpdateRef.current = { pageId, strokes, delivery };
      if (delivery === 'final' && presentationUpdateTimerRef.current !== null) {
        clearTimeout(presentationUpdateTimerRef.current);
        presentationUpdateTimerRef.current = null;
      }
      if (presentationUpdateInFlightRef.current) return;
      const elapsed = performance.now() - presentationUpdateLastStartedAtRef.current;
      const delay = Math.max(0, 125 - elapsed);
      if (delivery === 'final' || delay === 0) {
        flushPresentationUpdate();
        return;
      }
      if (presentationUpdateTimerRef.current === null)
        presentationUpdateTimerRef.current = setTimeout(() => {
          presentationUpdateTimerRef.current = null;
          flushPresentationUpdate();
        }, delay);
    },
    [flushPresentationUpdate],
  );

  const livePresentationRole = livePresentation?.role;
  const livePresentationSessionId = livePresentation?.sessionId;

  useEffect(() => {
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (
      livePresentationRole !== 'viewer' ||
      livePresentationSessionId === undefined ||
      revisionId === null ||
      apiOrigin === undefined
    )
      return;
    let stopped = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;
    const apply = (next: PublicPresentationSnapshotV1) => {
      const current = livePresentationRef.current;
      if (
        current === null ||
        current.sessionId !== next.sessionId ||
        next.version < current.version
      )
        return;
      livePresentationRef.current = next;
      setLivePresentation(next);
      if (next.currentPageId !== resolvedPageIdRef.current) setSelectedPageId(next.currentPageId);
    };
    const connect = () => {
      if (stopped) return;
      source?.close();
      source = new EventSource(
        ownerPresentationApi.eventsUrl({
          apiOrigin,
          boardId,
          revisionId,
          sessionId: livePresentationSessionId,
        }),
        { withCredentials: true },
      );
      source.addEventListener('presentation.state.v1', (event) => {
        if (!(event instanceof MessageEvent)) return;
        const next = ownerPresentationApi.parseEvent(String(event.data));
        if (next === null) return;
        retry = 0;
        apply(next);
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (stopped || retry >= 5) return;
        void ownerPresentationApi
          .get({ apiOrigin, boardId, revisionId, sessionId: livePresentationSessionId })
          .then((next) => {
            if (stopped) return;
            apply(next);
            retryTimer = setTimeout(connect, [250, 500, 1_000, 2_000, 4_000][retry++] ?? 4_000);
          })
          .catch(() => {
            if (stopped) return;
            retryTimer = setTimeout(connect, [250, 500, 1_000, 2_000, 4_000][retry++] ?? 4_000);
          });
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [boardId, livePresentationRole, livePresentationSessionId, ownerPresentationApi, revisionId]);

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
          currentPage: presentationSurfaceRef.current,
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
  useEffect(() => {
    presentationSessionAdmissionRef.current = {
      ...presentationSessionAdmissionRef.current,
      mounted: true,
    };
    return () => {
      presentationSessionAdmissionRef.current = {
        ...presentationSessionAdmissionRef.current,
        mounted: false,
      };
      presentationSessionOperationEpochRef.current += 1;
      presentationRequestEpochRef.current += 1;
      const ownedPage = presentationPageRef.current;
      presentationPageRef.current = null;
      presentationStateRef.current = createPresentationLifecycleStateV1();
      if (ownedPage !== null && document.fullscreenElement === ownedPage)
        void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
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

  const mediaResolver = useMemo(() => {
    const snapshot = session.visibleSnapshot;
    if (snapshot === null) return undefined;
    return createAccountMediaResolverV1({
      boardId: snapshot.boardId,
      revisionId: snapshot.revision.revisionId,
    });
  }, [session.visibleSnapshot]);

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
    state.mode.kind === 'history' || !affordances['board.write'] ? 'history' : 'live';
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
        presentationActive={presentationActive}
        onPresentationPageChange={(event) =>
          setArtifactPresentationPage({ outerPageKey: outerAnnotationPageKey, event })
        }
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
  const hasArtifact = pageRootContainsArtifactV1(pageRender.page.scene.root);
  const showArtifactControls = hasArtifact || rootIsDrawing;
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
  // 네이티브 페이지 컨트롤은 실제 캔버스가 있을 때만 의미가 있다. 아티팩트 전용 페이지에서는
  // 동작하지 않는 중복 버튼이 되므로 루트 캔버스가 없으면 렌더하지 않는다.
  const nativePageControls =
    rootCanvas !== null ? (
      <>
        <PageDisplayModeControls value={pageDisplayMode} onChange={selectPageDisplayMode} />
        <PageMoveModeControls
          available={moveAvailable}
          active={moveToggle && moveAvailable}
          onChange={setMoveToggle}
        />
      </>
    ) : null;
  const presentationControls = canUseOwnerPresentation ? (
    <PresentationModeControls
      active={presentationActive}
      disabled={presentationState.mode === 'requesting'}
      buttonRef={presentationButtonRef}
      onEnter={() => {
        setSessionDialogOpen(true);
        void refreshPresentationSessions();
      }}
      onExit={exitPresentation}
    />
  ) : null;
  const presentationRailControl = canUseOwnerPresentation ? (
    <PresentationModeControls
      active={presentationActive}
      disabled={presentationState.mode === 'requesting'}
      buttonRef={presentationButtonRef}
      onEnter={() => {
        setSessionDialogOpen(true);
        void refreshPresentationSessions();
      }}
      onExit={exitPresentation}
      variant="rail"
    />
  ) : null;
  const pageNavigationControls = (
    <PageNavigationControls
      current={resolvedPageIndex + 1}
      total={navigationDocument.pages.length}
      previousLabel={t('presentation.previousPage')}
      nextLabel={t('presentation.nextPage')}
      statusLabel={t('presentation.pageNavigation')}
      onPrevious={() => selectPage('previous')}
      onNext={() => selectPage('next')}
      navigationDisabled={presentationActive && livePresentation?.role === 'viewer'}
    />
  );
  const presentationTopBar = (
    <header className="board-topbar board-topbar-presentation">
      <div className="board-topbar-leading">
        <Brand linked href="https://sceneboard.dev" label="SceneBoard" />
      </div>
      <div className="board-topbar-title">
        <h2>{session.title}</h2>
      </div>
      <div className="board-topbar-actions">
        <div ref={setAnnotationToolbarTarget} className={styles.annotationToolbarSlot} />
        <div className="board-topbar-page-navigation">{pageNavigationControls}</div>
        {presentationControls}
      </div>
    </header>
  );
  const pageDisplayControls = (
    <div className="board-page-display-actions">
      {nativePageControls}
      {presentationControls}
    </div>
  );
  const desktopRevisionControls = affordances['history.read'] ? (
    <HistoryControls
      state={state}
      liveUpdated={session.liveUpdated}
      history={session.historyDropdown}
      onOpen={session.openHistory}
      onClose={session.closeHistory}
      onLoadMore={session.loadMoreHistory}
      onRetry={session.retryHistory}
      onSelectRevision={(revisionId) => void session.selectHistoryRevision(revisionId)}
      onSelectLatest={() => void session.selectLatestHistory()}
    />
  ) : null;
  const canManageShares = affordances['share.manage'];
  const canManageMembers = affordances['membership.manage'];
  const canReadShareAnalytics = affordances['analytics.read'];
  const canExport = affordances['export.render'];
  const canAdministerBoard = affordances['board.archive'] && affordances['board.delete'];
  const ownerAdmin =
    canManageShares &&
    canManageMembers &&
    canReadShareAnalytics &&
    canAdministerBoard &&
    canExport ? (
      <OwnerAdminControls
        ref={ownerAdminRef}
        api={api}
        exportApi={exportApi}
        invitationApi={invitationApi}
        shareApi={shareApi}
        analyticsApi={shareAnalyticsApi}
        boardId={boardId}
        boardTitle={session.title}
        revisionId={visibleSnapshot.revision.revisionId}
        revisionNumber={visibleSnapshot.revision.revisionNumber}
        documentFormat={
          'document' in visibleSnapshot && visibleSnapshot.document.schemaVersion === 3
            ? visibleSnapshot.document.format
            : 'wide_16_9'
        }
        canEditDocumentFormat={state.mode.kind === 'live' && affordances['board.write']}
        onDocumentFormatChange={session.changePresentationFormat}
        exportEnabled={canExport}
        analyticsEnabled={canReadShareAnalytics}
        routeKey={routeEpoch}
        onArchived={() => router.replace('/boards')}
      />
    ) : null;
  const mediaAuthoring =
    MEDIA_AUTHORING_UI_ENABLED &&
    affordances['media.upload'] &&
    state.mode.kind !== 'history' &&
    session.visibleSnapshot !== null &&
    'document' in session.visibleSnapshot &&
    resolvedPageId !== null ? (
      <BoardImageUploadControl
        coordinator={coordinator}
        boardId={boardId}
        document={session.visibleSnapshot.document}
        pageId={resolvedPageId}
        expectedRevisionId={session.visibleSnapshot.revision.revisionId}
        onRefresh={async () => {
          await session.latest(true);
        }}
        onPlaced={async () => {
          await session.latest(true);
        }}
        resolveCanvasViewport={() => {
          const transform = pageCanvasTransformRef.current;
          const page = pageScrollRef.current;
          if (transform === null || page === null) return null;
          const rect = page.getBoundingClientRect();
          return {
            transform,
            pageViewportRect: {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            },
            scrollTop: page.scrollTop,
          };
        }}
      />
    ) : null;
  const chromeSlots: MobileBoardDrawerSlotsV1 = {
    boardIdentity: (
      <BoardIdentitySlot
        title={session.title}
        state={state}
        onRename={session.rename}
        canRename={affordances['board.write']}
      />
    ),
    pageDisplay: pageDisplayControls,
    mediaAuthoring,
    history: affordances['history.read'] ? (
      <BoardHistorySlot
        state={state}
        liveUpdated={session.liveUpdated}
        viewMode={artifactViewMode}
        onViewModeChange={setArtifactViewMode}
        artifactZoom={selectedZoom}
        canResetArtifactView={canResetView}
        onResetArtifactView={resetView}
        showArtifactView={showArtifactControls}
        history={session.historyDropdown}
        onOpenHistory={session.openHistory}
        onCloseHistory={session.closeHistory}
        onLoadMoreHistory={session.loadMoreHistory}
        onRetryHistory={session.retryHistory}
        onSelectHistoryRevision={(revisionId) => void session.selectHistoryRevision(revisionId)}
        onSelectLatestHistory={() => void session.selectLatestHistory()}
      />
    ) : null,
    status: (
      <StatusRail
        snapshot={visibleSnapshot}
        presence={state.presence}
        onStopRendering={() => setArtifactStopSignal((value) => value + 1)}
      />
    ),
    connections: affordances['connection.create'] ? (
      <BoardConnectionsSlot
        state={state}
        pairingControl={
          <BoardPairingControl
            api={api}
            boardId={boardId}
            boardTitle={session.title}
            enabled={affordances['connection.create']}
            capabilityEpoch={accessForRender.capabilityEpoch}
            connectionGrantCeiling={accessForRender.connectionGrantCeiling}
          />
        }
      />
    ) : null,
    ownerAdmin,
  };
  const desktopBoardIdentity = (
    <BoardIdentitySlot
      compact
      title={session.title}
      state={state}
      onRename={session.rename}
      canRename={affordances['board.write']}
    />
  );
  // Desktop right utility rail — presentation and owner actions stay directly accessible as icons.
  const utilityRail = (
    <BoardUtilityRail
      snapshot={visibleSnapshot}
      presence={state.presence}
      onStopRendering={() => setArtifactStopSignal((value) => value + 1)}
      presentationControl={presentationRailControl}
      ownerAdmin={ownerAdmin}
    />
  );
  const navigationNotice = state.navigationError ? (
    <div className="notice notice-error" role="alert">
      {state.navigationError.message}
    </div>
  ) : null;
  return (
    <section
      ref={bindPresentationSurface}
      className={`board-workspace ${styles.workspace} ${presentationActive ? styles.presenting : ''} ${state.mode.kind === 'history' ? 'is-history' : ''}`}
    >
      <ResponsiveBoardChrome
        slots={chromeSlots}
        routeKey={`${boardId}:${visibleSnapshot.revision.revisionId}`}
        presentationActive={presentationActive}
        presentationTopBar={presentationTopBar}
        notice={navigationNotice}
        surfaceClassName={styles.surface ?? ''}
        utilityRail={utilityRail}
        desktopBoardIdentity={desktopBoardIdentity}
        pageNavigation={pageNavigationControls}
        revisionControls={desktopRevisionControls}
      >
        {capabilityAnnouncement !== null && (
          <span
            key={capabilityAnnouncement.epoch}
            className="visually-hidden"
            role="status"
            aria-live="polite"
          >
            {capabilityAnnouncement.message}
          </span>
        )}
        <PresentationStage
          stageRef={bindPageStage}
          mode={pageDisplayMode}
          canvasSize={rootCanvas}
          annotationPageKey={annotationPageKey}
          annotationToolbarTarget={annotationToolbarTarget}
          presentationActive={presentationActive}
          annotationReadOnly={livePresentation?.role === 'viewer'}
          annotationStrokes={
            livePresentation?.currentPageId === resolvedPageId
              ? livePresentation.annotation.strokes
              : []
          }
          onAnnotationStrokesChange={handlePresentationStrokesChange}
          moveToggle={moveToggle}
          moveIdentity={`${boardId}:${visibleSnapshot.revision.revisionId}:${resolvedPageId}`}
          onMoveAvailabilityChange={setMoveAvailable}
          onMoveCaptureActiveChange={setMoveCaptureActive}
          onCanvasTransformChange={bindPageCanvasTransform}
          label={t('board.sceneCanvas')}
          toolbar={<div className="board-stage-page-navigation">{pageNavigationControls}</div>}
          overlay={null}
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
            {...(mediaResolver === undefined ? {} : { mediaResolver })}
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
      <PublicPresentationSessionDialog
        open={sessionDialogOpen}
        busy={sessionDialogBusy}
        sessions={availableSessions}
        error={sessionDialogError}
        onClose={() => {
          presentationSessionOperationEpochRef.current += 1;
          setSessionDialogOpen(false);
          setSessionDialogBusy(false);
          setSessionDialogError(null);
        }}
        onRefresh={() => void refreshPresentationSessions()}
        onStart={() => void startLivePresentation()}
        onJoin={(sessionId) => void joinLivePresentation(sessionId)}
      />
    </section>
  );
}
