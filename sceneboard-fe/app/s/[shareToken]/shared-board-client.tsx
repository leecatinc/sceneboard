'use client';

import type {
  PageId,
  PublicPresentationSessionSummaryV1,
  PublicPresentationSnapshotV1,
  ShareAnalyticsContextV1,
} from '@sceneboard/board-schema';
import {
  PublicBoardRenderer,
  publicRenderTreeIsReadyV1,
  type PublicRenderReadyIdentityV1,
  type RendererComponentV1,
} from '@sceneboard/board-ui/renderer';
import type { ArtifactPresentationPageChangeEventV1 } from '@sceneboard/board-ui/artifact';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { PageNavigationControls } from '../../../components/board/PageNavigationControls';
import type { PresentationAnnotationDeliveryV1 } from '../../../components/board/PresentationAnnotationLayer';
import { PresentationModeControls } from '../../../components/board/PresentationModeControls';
import { PresentationStage } from '../../../components/board/PresentationStage';
import { Brand } from '../../../components/app/Brand';
import { useI18n } from '../../../components/i18n/I18nProvider';
import {
  createPublicShareMediaResolverV1,
  fetchPublicShareRevalidation,
} from '../../../lib/api/public-share-contract';
import { PublicArtifactPackageStoreV1 } from '../../../lib/api/public-share-artifact';
import {
  endPublicPresentationSessionV1,
  getPublicPresentationSessionV1,
  listPublicPresentationSessionsV1,
  parsePublicPresentationEventV1,
  publicPresentationEventsUrlV1,
  PublicPresentationApiError,
  startPublicPresentationSessionV1,
  updatePublicPresentationSessionV1,
} from '../../../lib/api/public-presentation-session';
import {
  presentationAnnotationPageKeyV1,
  type PresentationAnnotationStrokeV1,
} from '../../../lib/board/presentation-annotation.controller';
import { navigatePageIdV1 } from '../../../lib/board/page-navigation';
import { resolvePublicSharePageV1 } from '../../../lib/board/public-page-render-adapter';
import {
  publicShareAnnotationPageKeyV1,
  publicShareArtifactRouteKeyV1,
  publicShareProjectionTupleMatchesV1,
  publicShareViewerDeadlinesV1,
  publicShareViewerIdentityV1,
  samePublicShareViewerIdentityV1,
} from '../../../lib/board/public-share-viewer-state';
import {
  createShareAnalyticsIntentKeyV1,
  dispatchPublicShareAnalyticsEventV1,
  issuePublicShareAnalyticsContextV1,
} from '../../../lib/share-analytics/share-analytics-api';
import {
  elementIsActuallyVisibleV1,
  scheduleVisibleShareSignalV1,
} from '../../../lib/share-analytics/visible-signal';
import type { SharedBoardActionState } from './shared-board-actions';
import { PublicShareArtifactHost } from './public-share-artifact-host';
import { PublicPresentationSessionDialog } from './public-presentation-session-dialog';
import styles from './shared-board.module.css';

const PRESENTATION_UPDATE_INTERVAL_MS = 125;

export function SharedBoardClient({
  bootstrapAction,
  passwordAction,
}: {
  bootstrapAction: () => Promise<SharedBoardActionState>;
  passwordAction: (csrfToken: string, password: string) => Promise<SharedBoardActionState>;
}) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState(() => ({
    state: { state: 'unavailable' } as SharedBoardActionState,
    requestStartedAt: performance.now(),
  }));
  const [initializing, setInitializing] = useState(true);
  const [selectedPageId, setSelectedPageId] = useState<PageId | null>(null);
  const [password, setPassword] = useState('');
  const [presentationActive, setPresentationActive] = useState(false);
  const [artifactPresentationPage, setArtifactPresentationPage] = useState<{
    outerPageKey: string;
    event: ArtifactPresentationPageChangeEventV1;
  } | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionDialogBusy, setSessionDialogBusy] = useState(false);
  const [sessionDialogError, setSessionDialogError] = useState<string | null>(null);
  const [availableSessions, setAvailableSessions] = useState<
    readonly PublicPresentationSessionSummaryV1[]
  >([]);
  const [livePresentation, setLivePresentation] = useState<PublicPresentationSnapshotV1 | null>(
    null,
  );
  const [analyticsBootstrapEpoch, setAnalyticsBootstrapEpoch] = useState(1);
  const [pageActivationEpoch, setPageActivationEpoch] = useState(0);
  const [renderReady, setRenderReady] = useState<PublicRenderReadyIdentityV1 | null>(null);
  const [artifactStoreEntry, setArtifactStoreEntry] = useState<{
    key: string;
    store: PublicArtifactPackageStoreV1;
  } | null>(null);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const [analyticsContext, setAnalyticsContext] = useState<{
    bootstrapEpoch: number;
    tupleKey: string;
    value: ShareAnalyticsContextV1;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const stateRef = useRef(accepted);
  const requestEpochRef = useRef(0);
  const initialBootstrapStartedRef = useRef(false);
  const routeEpochRef = useRef(crypto.randomUUID());
  const requestAbortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const presentationButtonRef = useRef<HTMLButtonElement | null>(null);
  const annotationToolbarRef = useRef<HTMLDivElement | null>(null);
  const fullscreenWasActiveRef = useRef(false);
  const handleFullscreenExitRef = useRef<() => void>(() => undefined);
  const analyticsContextRef = useRef(analyticsContext);
  const artifactStoreEntryRef = useRef(artifactStoreEntry);
  const currentRenderRef = useRef<{
    tupleKey: string;
    pageId: string;
    renderEpoch: number;
  } | null>(null);
  const analyticsIntentRef = useRef(new Set<string>());
  const analyticsFirstIntentRef = useRef(new Set<string>());
  const livePresentationRef = useRef(livePresentation);
  const presenterStrokesRef = useRef<readonly PresentationAnnotationStrokeV1[]>([]);
  const pendingPresentationUpdateRef = useRef<{
    pageId: PageId;
    strokes: readonly PresentationAnnotationStrokeV1[];
    delivery: PresentationAnnotationDeliveryV1;
  } | null>(null);
  const presentationUpdateInFlightRef = useRef(false);
  const presentationUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presentationUpdateLastStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const flushPresentationUpdateRef = useRef<() => void>(() => undefined);
  const schedulePresentationUpdateRef = useRef<
    (delivery: PresentationAnnotationDeliveryV1) => void
  >(() => undefined);
  const resolvedPageIdRef = useRef<PageId | null>(null);
  stateRef.current = accepted;
  analyticsContextRef.current = analyticsContext;
  artifactStoreEntryRef.current = artifactStoreEntry;
  livePresentationRef.current = livePresentation;

  const focusState = useCallback((selector: string) => {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
  }, []);

  const invalidate = useCallback(() => {
    requestEpochRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setSelectedPageId(null);
    setRenderReady(null);
    setAnalyticsContext(null);
    analyticsIntentRef.current.clear();
    analyticsFirstIntentRef.current.clear();
    setPassword('');
    setPresentationActive(false);
    setSessionDialogOpen(false);
    setLivePresentation(null);
    pendingPresentationUpdateRef.current = null;
    presentationUpdateLastStartedAtRef.current = Number.NEGATIVE_INFINITY;
    if (presentationUpdateTimerRef.current !== null)
      clearTimeout(presentationUpdateTimerRef.current);
    presentationUpdateTimerRef.current = null;
    if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined);
    setAccepted({ state: { state: 'unavailable' }, requestStartedAt: performance.now() });
    focusState('[data-shared-unavailable-heading]');
  }, [focusState]);

  const acceptBootstrap = useCallback(
    (state: SharedBoardActionState, requestStartedAt: number) => {
      requestEpochRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      setSelectedPageId(null);
      setPageActivationEpoch(0);
      setAnalyticsBootstrapEpoch((current) => current + 1);
      setRenderReady(null);
      setAnalyticsContext(null);
      analyticsIntentRef.current.clear();
      analyticsFirstIntentRef.current.clear();
      setAccepted({ state, requestStartedAt });
      if (state.state === 'ready') focusState('[data-page-heading]');
      else if (state.state === 'password-required' || state.state === 'password-invalid')
        focusState('[data-shared-password-input]');
      else if (state.state === 'rate-limited') focusState('[data-shared-rate-limited-heading]');
      else focusState('[data-shared-unavailable-heading]');
    },
    [focusState],
  );

  const reboot = useCallback(() => {
    const requestStartedAt = performance.now();
    const epoch = ++requestEpochRef.current;
    void bootstrapAction()
      .then((state) => {
        if (requestEpochRef.current !== epoch) return;
        acceptBootstrap(state, requestStartedAt);
      })
      .catch(() => {
        if (requestEpochRef.current === epoch) invalidate();
      });
  }, [acceptBootstrap, bootstrapAction, invalidate]);

  useEffect(() => {
    if (initialBootstrapStartedRef.current) return;
    initialBootstrapStartedRef.current = true;
    const requestStartedAt = performance.now();
    const epoch = ++requestEpochRef.current;
    void bootstrapAction()
      .then((state) => {
        if (requestEpochRef.current !== epoch) return;
        setInitializing(false);
        acceptBootstrap(state, requestStartedAt);
      })
      .catch(() => {
        if (requestEpochRef.current !== epoch) return;
        setInitializing(false);
        invalidate();
      });
  }, [acceptBootstrap, bootstrapAction, invalidate]);

  const revalidate = useCallback(() => {
    const current = stateRef.current;
    if (current.state.state !== 'ready') return;
    const displayed = current.state;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestEpoch = ++requestEpochRef.current;
    const identity = publicShareViewerIdentityV1(routeEpochRef.current, displayed, requestEpoch);
    const requestStartedAt = performance.now();
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (apiOrigin === undefined) {
      invalidate();
      return;
    }
    void fetchPublicShareRevalidation({
      apiOrigin,
      contextId: displayed.context.contextId,
      signal: controller.signal,
    })
      .then((state) => {
        if (controller.signal.aborted || stateRef.current.state.state !== 'ready') return;
        const currentIdentity = publicShareViewerIdentityV1(
          routeEpochRef.current,
          stateRef.current.state,
          requestEpochRef.current,
        );
        if (!samePublicShareViewerIdentityV1(identity, currentIdentity)) return;
        if (state.state === 'unavailable') {
          invalidate();
          return;
        }
        if (state.state === 'rate-limited') {
          const { hardExpiryAt } = publicShareViewerDeadlinesV1(current.requestStartedAt);
          const retryAt = performance.now() + state.retryAfterSeconds * 1_000;
          if (retryAt < hardExpiryAt)
            retryTimerRef.current = setTimeout(revalidate, state.retryAfterSeconds * 1_000);
          return;
        }
        if (!publicShareProjectionTupleMatchesV1(displayed, state)) {
          invalidate();
          return;
        }
        setAccepted({ state, requestStartedAt });
      })
      .catch(() => {
        // Network failure may retain the accepted projection only until the hard deadline.
      });
  }, [invalidate]);

  useEffect(() => {
    const current = accepted;
    if (current.state.state !== 'ready') return;
    const deadlines = publicShareViewerDeadlinesV1(current.requestStartedAt);
    const earlyTimer = setTimeout(
      () => {
        if (document.visibilityState === 'visible') revalidate();
      },
      Math.max(0, deadlines.earlyRefreshAt - performance.now()),
    );
    const hardTimer = setTimeout(
      invalidate,
      Math.max(0, deadlines.hardExpiryAt - performance.now()),
    );
    return () => {
      clearTimeout(earlyTimer);
      clearTimeout(hardTimer);
    };
  }, [accepted, invalidate, revalidate]);

  useEffect(() => {
    const resume = () => {
      const current = stateRef.current;
      if (current.state.state !== 'ready') return;
      const { hardExpiryAt } = publicShareViewerDeadlinesV1(current.requestStartedAt);
      if (performance.now() >= hardExpiryAt) reboot();
      else if (document.visibilityState === 'visible') revalidate();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      requestAbortRef.current?.abort();
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    };
  }, [reboot, revalidate]);

  useEffect(() => {
    const changed = () => {
      const active = document.fullscreenElement === pageRef.current;
      const exited = fullscreenWasActiveRef.current && !active;
      fullscreenWasActiveRef.current = active;
      if (exited) handleFullscreenExitRef.current();
      else setPresentationActive(active);
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  useEffect(() => {
    const changed = () => setVisibilityEpoch((current) => current + 1);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('resize', changed);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('resize', changed);
    };
  }, []);

  const ready = accepted.state.state === 'ready' ? accepted.state : null;
  const resolved = useMemo(
    () => (ready === null ? null : resolvePublicSharePageV1(ready.projection, selectedPageId)),
    [ready, selectedPageId],
  );
  resolvedPageIdRef.current = resolved?.pageId ?? null;
  const mediaResolver = useMemo(
    () => (ready === null ? undefined : createPublicShareMediaResolverV1(ready)),
    [ready],
  );
  const artifactRouteEpoch = ready === null ? null : publicShareArtifactRouteKeyV1(ready);
  const artifactApiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
  const artifactRuntimeOrigin = process.env.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN ?? '';
  const artifactStoreKey =
    artifactRouteEpoch === null || artifactApiOrigin === undefined
      ? null
      : `${artifactApiOrigin}\u0000${artifactRouteEpoch}`;
  useEffect(() => {
    const current = artifactStoreEntryRef.current;
    if (ready === null || artifactStoreKey === null || artifactApiOrigin === undefined) {
      current?.store.dispose();
      artifactStoreEntryRef.current = null;
      setArtifactStoreEntry(null);
      return;
    }
    if (current?.key === artifactStoreKey) {
      try {
        current.store.renew(ready);
      } catch {
        current.store.dispose();
        artifactStoreEntryRef.current = null;
        setArtifactStoreEntry(null);
      }
      return;
    }
    let next: { key: string; store: PublicArtifactPackageStoreV1 } | null = null;
    try {
      next = {
        key: artifactStoreKey,
        store: new PublicArtifactPackageStoreV1(ready, { apiOrigin: artifactApiOrigin }),
      };
    } catch {}
    current?.store.dispose();
    artifactStoreEntryRef.current = next;
    setArtifactStoreEntry(next);
  }, [artifactApiOrigin, artifactStoreKey, ready]);
  useEffect(
    () => () => {
      artifactStoreEntryRef.current?.store.dispose();
      artifactStoreEntryRef.current = null;
    },
    [],
  );
  const artifactStore =
    artifactStoreEntry?.key === artifactStoreKey ? artifactStoreEntry.store : null;
  const artifactSnapshotWatermark = ready?.projection.publicationGeneration ?? 0;
  const outerAnnotationPageKey =
    ready === null || resolved === null
      ? 'unavailable'
      : publicShareAnnotationPageKeyV1(ready, resolved.pageId);
  const annotationPageKey = presentationAnnotationPageKeyV1(
    outerAnnotationPageKey,
    artifactPresentationPage?.outerPageKey === outerAnnotationPageKey
      ? artifactPresentationPage.event
      : null,
  );
  const renderArtifact = useCallback<RendererComponentV1<'content.artifact'>>(
    ({ node, context }) => {
      const summary = context.artifacts.find(
        (candidate) =>
          candidate.artifact.artifactId === node.artifact.artifactId &&
          candidate.artifact.versionId === node.artifact.versionId,
      );
      if (
        artifactStore === null ||
        artifactRouteEpoch === null ||
        artifactRuntimeOrigin.length === 0 ||
        summary?.status !== 'ready'
      )
        return (
          <div className="artifact-fallback" role="alert">
            {t('board.artifactUnavailable')}
          </div>
        );
      return (
        <PublicShareArtifactHost
          store={artifactStore}
          boardId={context.boardId}
          artifact={node.artifact}
          nodeId={node.id}
          runtimeOrigin={artifactRuntimeOrigin}
          routeEpoch={artifactRouteEpoch}
          snapshotWatermark={artifactSnapshotWatermark}
          presentationActive={presentationActive}
          onPresentationPageChange={(event) =>
            setArtifactPresentationPage({ outerPageKey: outerAnnotationPageKey, event })
          }
        />
      );
    },
    [
      artifactRouteEpoch,
      artifactRuntimeOrigin,
      artifactSnapshotWatermark,
      artifactStore,
      outerAnnotationPageKey,
      presentationActive,
      t,
    ],
  );
  const analyticsTupleKey =
    ready === null
      ? null
      : [
          ready.projection.shareId,
          ready.projection.revisionId,
          ready.projection.publicationGeneration,
          ready.projection.accessGeneration,
          ...ready.projection.document.pages.map((page) => page.pageId),
        ].join('\u0000');
  const renderEpoch = analyticsBootstrapEpoch * 1_000_000 + pageActivationEpoch;
  currentRenderRef.current =
    ready === null || resolved === null || analyticsTupleKey === null
      ? null
      : { tupleKey: analyticsTupleKey, pageId: resolved.pageId, renderEpoch };

  useEffect(() => {
    const currentState = stateRef.current.state;
    if (currentState.state !== 'ready' || analyticsTupleKey === null) return;
    const projection = currentState.projection;
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (apiOrigin === undefined) return;
    const expectedEpoch = analyticsBootstrapEpoch;
    const expectedTuple = analyticsTupleKey;
    const expectedPages = projection.document.pages.map((page) => page.pageId);
    const controller = new AbortController();
    void issuePublicShareAnalyticsContextV1({
      apiOrigin,
      shareId: projection.shareId,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted || result.kind !== 'ok') return;
      const current = currentRenderRef.current;
      if (
        current === null ||
        current.tupleKey !== expectedTuple ||
        expectedEpoch !== analyticsBootstrapEpoch ||
        result.value.revisionId !== projection.revisionId ||
        result.value.publicationGeneration !== projection.publicationGeneration ||
        result.value.accessGeneration !== projection.accessGeneration ||
        result.value.pageIds.length !== expectedPages.length ||
        result.value.pageIds.some((pageId, index) => pageId !== expectedPages[index])
      )
        return;
      setAnalyticsContext({
        bootstrapEpoch: expectedEpoch,
        tupleKey: expectedTuple,
        value: result.value,
      });
    });
    return () => controller.abort();
  }, [analyticsBootstrapEpoch, analyticsTupleKey]);

  useEffect(() => {
    const boardId = ready?.projection.boardId ?? null;
    const revisionId = ready?.projection.revisionId ?? null;
    const pageId = resolved?.pageId ?? null;
    const rendererRoot =
      stageRef.current?.querySelector<HTMLElement>(`[data-public-render-epoch="${renderEpoch}"]`) ??
      null;
    if (
      analyticsContext === null ||
      renderReady === null ||
      analyticsTupleKey === null ||
      boardId === null ||
      revisionId === null ||
      pageId === null ||
      stageRef.current === null ||
      rendererRoot === null ||
      analyticsContext.bootstrapEpoch !== analyticsBootstrapEpoch ||
      analyticsContext.tupleKey !== analyticsTupleKey ||
      renderReady.boardId !== boardId ||
      renderReady.revisionId !== revisionId ||
      renderReady.pageId !== pageId ||
      renderReady.renderEpoch !== renderEpoch ||
      !analyticsContext.value.pageIds.includes(pageId) ||
      Date.now() >= Date.parse(analyticsContext.value.expiresAt) ||
      !publicRenderTreeIsReadyV1(rendererRoot) ||
      !elementIsActuallyVisibleV1(stageRef.current)
    )
      return;
    const activationKey = `${analyticsContext.value.viewContextId}\u0000${renderEpoch}`;
    const intents = analyticsIntentRef.current;
    if (intents.has(activationKey)) return;
    intents.add(activationKey);
    const controller = new AbortController();
    let dispatched = false;
    const cancelVisible = scheduleVisibleShareSignalV1({
      element: stageRef.current,
      isCurrent: () => {
        const current = currentRenderRef.current;
        return (
          !controller.signal.aborted &&
          current?.tupleKey === analyticsTupleKey &&
          current.pageId === pageId &&
          current.renderEpoch === renderEpoch &&
          analyticsContextRef.current === analyticsContext &&
          publicRenderTreeIsReadyV1(rendererRoot)
        );
      },
      onVisible: () => {
        dispatched = true;
        const firstIntents = analyticsFirstIntentRef.current;
        const eventKind = firstIntents.has(analyticsContext.value.viewContextId)
          ? 'page-visible'
          : 'first-visible';
        firstIntents.add(analyticsContext.value.viewContextId);
        const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
        if (apiOrigin === undefined) return;
        void dispatchPublicShareAnalyticsEventV1({
          apiOrigin,
          context: analyticsContext.value,
          eventKind,
          pageId,
          idempotencyKey: createShareAnalyticsIntentKeyV1(),
          signal: controller.signal,
          isCurrent: () => {
            const current = currentRenderRef.current;
            return (
              current?.tupleKey === analyticsTupleKey &&
              current.pageId === pageId &&
              current.renderEpoch === renderEpoch &&
              analyticsContextRef.current === analyticsContext &&
              publicRenderTreeIsReadyV1(rendererRoot)
            );
          },
        }).then((result) => {
          if (
            result.kind === 'context_evicted' &&
            analyticsContextRef.current === analyticsContext
          ) {
            analyticsContextRef.current = null;
            setAnalyticsContext(null);
          }
        });
      },
    });
    return () => {
      cancelVisible();
      controller.abort();
      if (!dispatched) intents.delete(activationKey);
    };
  }, [
    analyticsBootstrapEpoch,
    analyticsContext,
    analyticsTupleKey,
    ready?.projection.boardId,
    ready?.projection.revisionId,
    renderEpoch,
    renderReady,
    resolved?.pageId,
    visibilityEpoch,
  ]);

  const selectSharedPage = useCallback((pageId: PageId) => {
    if (stageRef.current !== null) stageRef.current.scrollTop = 0;
    setRenderReady(null);
    setPageActivationEpoch((current) => current + 1);
    setSelectedPageId(pageId);
  }, []);

  const handleRenderReady = useCallback((identity: PublicRenderReadyIdentityV1) => {
    const current = currentRenderRef.current;
    if (
      current !== null &&
      identity.pageId === current.pageId &&
      identity.renderEpoch === current.renderEpoch
    )
      setRenderReady(identity);
  }, []);

  const enterPresentationFullscreen = useCallback(() => {
    const page = pageRef.current;
    if (page === null) return;
    void page
      .requestFullscreen()
      .then(() => setPresentationActive(true))
      .catch(() => {
        setPresentationActive(true);
        page.focus();
      });
  }, []);

  const refreshPresentationSessions = useCallback(async () => {
    const current = stateRef.current.state;
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (current.state !== 'ready' || apiOrigin === undefined) return;
    setSessionDialogBusy(true);
    setSessionDialogError(null);
    try {
      const result = await listPublicPresentationSessionsV1({
        apiOrigin,
        contextId: current.context.contextId,
      });
      setAvailableSessions(result.sessions);
    } catch {
      setSessionDialogError(t('presentation.liveSessionUnavailable'));
    } finally {
      setSessionDialogBusy(false);
    }
  }, [t]);

  const activateLivePresentation = useCallback(
    (snapshot: PublicPresentationSnapshotV1) => {
      pendingPresentationUpdateRef.current = null;
      presentationUpdateLastStartedAtRef.current = Number.NEGATIVE_INFINITY;
      setLivePresentation(snapshot);
      if (snapshot.currentPageId !== resolvedPageIdRef.current)
        selectSharedPage(snapshot.currentPageId);
      setSessionDialogOpen(false);
      setSessionDialogError(null);
      enterPresentationFullscreen();
    },
    [enterPresentationFullscreen, selectSharedPage],
  );

  const startLivePresentation = useCallback(async () => {
    const current = stateRef.current.state;
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    const pageId = resolvedPageIdRef.current;
    if (current.state !== 'ready' || apiOrigin === undefined || pageId === null) return;
    setSessionDialogBusy(true);
    setSessionDialogError(null);
    try {
      activateLivePresentation(
        await startPublicPresentationSessionV1({
          apiOrigin,
          contextId: current.context.contextId,
          currentPageId: pageId,
        }),
      );
    } catch {
      setSessionDialogError(t('presentation.liveSessionUnavailable'));
    } finally {
      setSessionDialogBusy(false);
    }
  }, [activateLivePresentation, t]);

  const joinLivePresentation = useCallback(
    async (sessionId: string) => {
      const current = stateRef.current.state;
      const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
      if (current.state !== 'ready' || apiOrigin === undefined) return;
      setSessionDialogBusy(true);
      setSessionDialogError(null);
      try {
        activateLivePresentation(
          await getPublicPresentationSessionV1({
            apiOrigin,
            contextId: current.context.contextId,
            sessionId,
          }),
        );
      } catch {
        setSessionDialogError(t('presentation.liveSessionUnavailable'));
        await refreshPresentationSessions();
      } finally {
        setSessionDialogBusy(false);
      }
    },
    [activateLivePresentation, refreshPresentationSessions, t],
  );

  const exitLivePresentation = useCallback(() => {
    const current = stateRef.current.state;
    const session = livePresentationRef.current;
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (current.state === 'ready' && session?.role === 'presenter' && apiOrigin !== undefined)
      void endPublicPresentationSessionV1({
        apiOrigin,
        contextId: current.context.contextId,
        sessionId: session.sessionId,
      }).catch(() => undefined);
    livePresentationRef.current = null;
    fullscreenWasActiveRef.current = false;
    setLivePresentation(null);
    pendingPresentationUpdateRef.current = null;
    presentationUpdateLastStartedAtRef.current = Number.NEGATIVE_INFINITY;
    if (presentationUpdateTimerRef.current !== null)
      clearTimeout(presentationUpdateTimerRef.current);
    presentationUpdateTimerRef.current = null;
    if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined);
    setPresentationActive(false);
  }, []);
  handleFullscreenExitRef.current = exitLivePresentation;

  const flushPresentationUpdate = useCallback(() => {
    if (presentationUpdateInFlightRef.current) return;
    const pending = pendingPresentationUpdateRef.current;
    const current = stateRef.current.state;
    const session = livePresentationRef.current;
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (
      pending === null ||
      current.state !== 'ready' ||
      session?.role !== 'presenter' ||
      apiOrigin === undefined
    )
      return;
    pendingPresentationUpdateRef.current = null;
    presentationUpdateInFlightRef.current = true;
    presentationUpdateLastStartedAtRef.current = performance.now();
    void (async () => {
      const makeUpdate = (expectedVersion: number) =>
        updatePublicPresentationSessionV1({
          apiOrigin,
          contextId: current.context.contextId,
          sessionId: session.sessionId,
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
      try {
        let next: PublicPresentationSnapshotV1;
        try {
          next = await makeUpdate(session.version);
        } catch (error) {
          if (!(error instanceof PublicPresentationApiError) || error.status !== 409) throw error;
          const latest = await getPublicPresentationSessionV1({
            apiOrigin,
            contextId: current.context.contextId,
            sessionId: session.sessionId,
          });
          if (latest.role !== 'presenter') throw error;
          next = await makeUpdate(latest.version);
        }
        if (livePresentationRef.current?.sessionId === next.sessionId) {
          livePresentationRef.current = next;
          setLivePresentation(next);
        }
      } catch {
        setSessionDialogError(t('presentation.liveSessionUnavailable'));
      } finally {
        presentationUpdateInFlightRef.current = false;
        const nextPending = pendingPresentationUpdateRef.current;
        if (nextPending !== null) schedulePresentationUpdateRef.current(nextPending.delivery);
      }
    })();
  }, [t]);
  flushPresentationUpdateRef.current = flushPresentationUpdate;

  const schedulePresentationUpdate = useCallback((delivery: PresentationAnnotationDeliveryV1) => {
    if (
      pendingPresentationUpdateRef.current === null ||
      presentationUpdateInFlightRef.current ||
      presentationUpdateTimerRef.current !== null
    )
      return;
    const now = performance.now();
    const elapsed = now - presentationUpdateLastStartedAtRef.current;
    const delay =
      delivery === 'transient' && !Number.isFinite(elapsed)
        ? PRESENTATION_UPDATE_INTERVAL_MS
        : Math.max(0, PRESENTATION_UPDATE_INTERVAL_MS - elapsed);
    if (delay === 0) {
      flushPresentationUpdateRef.current();
      return;
    }
    presentationUpdateTimerRef.current = setTimeout(() => {
      presentationUpdateTimerRef.current = null;
      flushPresentationUpdateRef.current();
    }, delay);
  }, []);
  schedulePresentationUpdateRef.current = schedulePresentationUpdate;

  const handlePresentationStrokesChange = useCallback(
    (
      strokes: readonly PresentationAnnotationStrokeV1[],
      delivery: PresentationAnnotationDeliveryV1,
    ) => {
      presenterStrokesRef.current = strokes;
      const pageId = resolvedPageIdRef.current;
      if (pageId === null || livePresentationRef.current?.role !== 'presenter') return;
      pendingPresentationUpdateRef.current = { pageId, strokes, delivery };
      if (delivery === 'final' && presentationUpdateTimerRef.current !== null) {
        clearTimeout(presentationUpdateTimerRef.current);
        presentationUpdateTimerRef.current = null;
      }
      schedulePresentationUpdateRef.current(delivery);
    },
    [],
  );

  const livePresentationRole = livePresentation?.role;
  const livePresentationSessionId = livePresentation?.sessionId;
  const publicContextId = ready?.context.contextId;

  useEffect(() => {
    const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
    if (
      publicContextId === undefined ||
      livePresentationRole !== 'viewer' ||
      livePresentationSessionId === undefined ||
      apiOrigin === undefined
    )
      return;
    let stopped = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;
    const applySnapshot = (next: PublicPresentationSnapshotV1) => {
      const active = livePresentationRef.current;
      if (active === null || active.sessionId !== next.sessionId || next.version < active.version)
        return;
      setLivePresentation(next);
      if (next.currentPageId !== resolvedPageIdRef.current) selectSharedPage(next.currentPageId);
    };
    const connect = () => {
      if (stopped) return;
      source?.close();
      source = new EventSource(
        publicPresentationEventsUrlV1({
          apiOrigin,
          contextId: publicContextId,
          sessionId: livePresentationSessionId,
        }),
        { withCredentials: true },
      );
      source.addEventListener('presentation.state.v1', (event) => {
        if (!(event instanceof MessageEvent)) return;
        const next = parsePublicPresentationEventV1(String(event.data));
        if (next === null) return;
        retry = 0;
        applySnapshot(next);
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (stopped || retry >= 5) return;
        void getPublicPresentationSessionV1({
          apiOrigin,
          contextId: publicContextId,
          sessionId: livePresentationSessionId,
        })
          .then((next) => {
            if (stopped) return;
            applySnapshot(next);
            const delay = [250, 500, 1_000, 2_000, 4_000][retry++] ?? 4_000;
            retryTimer = setTimeout(connect, delay);
          })
          .catch((error) => {
            if (stopped) return;
            if (error instanceof PublicPresentationApiError && error.status === 404) {
              exitLivePresentation();
              setSessionDialogError(t('presentation.liveSessionEnded'));
              setSessionDialogOpen(true);
              void refreshPresentationSessions();
              return;
            }
            const delay = [250, 500, 1_000, 2_000, 4_000][retry++] ?? 4_000;
            retryTimer = setTimeout(connect, delay);
          });
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [
    exitLivePresentation,
    livePresentationRole,
    livePresentationSessionId,
    publicContextId,
    refreshPresentationSessions,
    selectSharedPage,
    t,
  ]);

  useEffect(
    () => () => {
      if (presentationUpdateTimerRef.current !== null)
        clearTimeout(presentationUpdateTimerRef.current);
    },
    [],
  );

  if (initializing)
    return (
      <main className={styles.page} aria-busy="true">
        <section className={styles.status}>
          <p>{t('common.loading')}</p>
        </section>
      </main>
    );

  if (accepted.state.state === 'password-required' || accepted.state.state === 'password-invalid') {
    const csrfToken = accepted.state.csrfToken;
    return (
      <main className={styles.page}>
        <section className={styles.status}>
          <h1>{t('sharing.passwordRequired')}</h1>
          <form
            className={styles.passwordForm}
            onSubmit={(event) => {
              event.preventDefault();
              const requestStartedAt = performance.now();
              const requestEpoch = ++requestEpochRef.current;
              startTransition(() => {
                void passwordAction(csrfToken, password).then((state) => {
                  if (requestEpochRef.current !== requestEpoch) return;
                  setPassword('');
                  acceptBootstrap(state, requestStartedAt);
                });
              });
            }}
          >
            <label htmlFor="shared-board-password">{t('sharing.passwordLabel')}</label>
            <input
              id="shared-board-password"
              data-shared-password-input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {accepted.state.state === 'password-invalid' && (
              <p role="alert">{t('sharing.passwordInvalid')}</p>
            )}
            <button type="submit" disabled={isPending || password.length === 0}>
              {t('sharing.openSharedBoard')}
            </button>
          </form>
        </section>
      </main>
    );
  }

  if (accepted.state.state === 'rate-limited')
    return (
      <main className={styles.page}>
        <section className={styles.status}>
          <h1 tabIndex={-1} data-shared-rate-limited-heading>
            {t('sharing.rateLimited')}
          </h1>
          <p>{accepted.state.retryAfterSeconds}</p>
        </section>
      </main>
    );

  if (ready === null || resolved === null)
    return (
      <main className={styles.page}>
        <section className={styles.status}>
          <h1 tabIndex={-1} data-shared-unavailable-heading>
            {t('sharing.unavailable')}
          </h1>
        </section>
      </main>
    );

  return (
    <main className={styles.page} ref={pageRef} tabIndex={-1}>
      <div className={styles.shell}>
        <header className="board-topbar board-topbar-presentation">
          <div className="board-topbar-leading">
            <Brand linked href="https://sceneboard.dev" label="SceneBoard" />
          </div>
          <div className="board-topbar-title">
            <h2>{ready.projection.title}</h2>
          </div>
          <div className="board-topbar-actions">
            <div ref={annotationToolbarRef} className={styles.annotationToolbarSlot} />
            <div className="board-topbar-page-navigation">
              <PageNavigationControls
                current={resolved.pageIndex + 1}
                total={ready.projection.document.pages.length}
                previousLabel={t('presentation.previousPage')}
                nextLabel={t('presentation.nextPage')}
                statusLabel={t('presentation.pageNavigation')}
                onPrevious={() =>
                  selectSharedPage(
                    navigatePageIdV1(ready.projection.document, resolved.pageId, 'previous'),
                  )
                }
                onNext={() =>
                  selectSharedPage(
                    navigatePageIdV1(ready.projection.document, resolved.pageId, 'next'),
                  )
                }
                navigationDisabled={presentationActive && livePresentation?.role === 'viewer'}
              />
            </div>
            <PresentationModeControls
              active={presentationActive}
              disabled={false}
              buttonRef={presentationButtonRef}
              onEnter={() => {
                setSessionDialogOpen(true);
                void refreshPresentationSessions();
              }}
              onExit={exitLivePresentation}
            />
          </div>
        </header>
        <article className={styles.reader}>
          <PresentationStage
            stageRef={(element) => {
              stageRef.current = element;
            }}
            mode={resolved.page.displayMode}
            canvasSize={null}
            toolbar={null}
            annotationToolbarTarget={annotationToolbarRef.current}
            annotationPageKey={annotationPageKey}
            overlay={null}
            presentationActive={presentationActive}
            annotationReadOnly={livePresentation?.role === 'viewer'}
            annotationStrokes={
              livePresentation?.currentPageId === resolved.pageId
                ? livePresentation.annotation.strokes
                : []
            }
            onAnnotationStrokesChange={handlePresentationStrokesChange}
            moveToggle={resolved.page.displayMode === 'actual-size'}
            moveIdentity={`${artifactRouteEpoch ?? 'unavailable'}:${resolved.pageId}`}
            onMoveAvailabilityChange={() => undefined}
            onMoveCaptureActiveChange={() => undefined}
            label={t('sharing.readerLabel')}
          >
            <PublicBoardRenderer
              key={`${analyticsTupleKey}:${resolved.pageId}:${renderEpoch}`}
              page={resolved.page}
              {...(mediaResolver === undefined ? {} : { mediaResolver })}
              context={{
                surface: 'public-share',
                boardId: ready.projection.boardId,
                revisionId: ready.projection.revisionId,
                publicationGeneration: ready.projection.publicationGeneration,
                accessGeneration: ready.projection.accessGeneration,
                artifacts: ready.projection.artifacts,
                media: ready.projection.media,
                selectedPageId: resolved.pageId,
              }}
              renderEpoch={renderEpoch}
              onRenderReady={handleRenderReady}
              renderArtifact={renderArtifact}
            />
          </PresentationStage>
        </article>
      </div>
      <PublicPresentationSessionDialog
        open={sessionDialogOpen}
        busy={sessionDialogBusy}
        sessions={availableSessions}
        error={sessionDialogError}
        onClose={() => setSessionDialogOpen(false)}
        onRefresh={() => void refreshPresentationSessions()}
        onStart={() => void startLivePresentation()}
        onJoin={(sessionId) => void joinLivePresentation(sessionId)}
      />
    </main>
  );
}
