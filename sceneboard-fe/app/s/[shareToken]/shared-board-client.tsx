'use client';

import type { PageId, ShareAnalyticsContextV1 } from '@sceneboard/board-schema';
import {
  PublicBoardRenderer,
  publicRenderTreeIsReadyV1,
  type PublicRenderReadyIdentityV1,
} from '@sceneboard/board-ui/renderer';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { PageNavigationControls } from '../../../components/board/PageNavigationControls';
import { PresentationModeControls } from '../../../components/board/PresentationModeControls';
import { PresentationStage } from '../../../components/board/PresentationStage';
import { useI18n } from '../../../components/i18n/I18nProvider';
import {
  createPublicShareMediaResolverV1,
  fetchPublicShareRevalidation,
} from '../../../lib/api/public-share-contract';
import { navigatePageIdV1 } from '../../../lib/board/page-navigation';
import { resolvePublicSharePageV1 } from '../../../lib/board/public-page-render-adapter';
import {
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
import styles from './shared-board.module.css';

export function SharedBoardClient({
  initialState,
  bootstrapAction,
  passwordAction,
}: {
  initialState: SharedBoardActionState;
  bootstrapAction: () => Promise<SharedBoardActionState>;
  passwordAction: (csrfToken: string, password: string) => Promise<SharedBoardActionState>;
}) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState(() => ({
    state: initialState,
    requestStartedAt: performance.now(),
  }));
  const [selectedPageId, setSelectedPageId] = useState<PageId | null>(null);
  const [password, setPassword] = useState('');
  const [presentationActive, setPresentationActive] = useState(false);
  const [analyticsBootstrapEpoch, setAnalyticsBootstrapEpoch] = useState(1);
  const [pageActivationEpoch, setPageActivationEpoch] = useState(0);
  const [renderReady, setRenderReady] = useState<PublicRenderReadyIdentityV1 | null>(null);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const [analyticsContext, setAnalyticsContext] = useState<{
    bootstrapEpoch: number;
    tupleKey: string;
    value: ShareAnalyticsContextV1;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const stateRef = useRef(accepted);
  const requestEpochRef = useRef(0);
  const routeEpochRef = useRef(crypto.randomUUID());
  const requestAbortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const presentationButtonRef = useRef<HTMLButtonElement | null>(null);
  const analyticsContextRef = useRef(analyticsContext);
  const currentRenderRef = useRef<{
    tupleKey: string;
    pageId: string;
    renderEpoch: number;
  } | null>(null);
  const analyticsIntentRef = useRef(new Set<string>());
  const analyticsFirstIntentRef = useRef(new Set<string>());
  stateRef.current = accepted;
  analyticsContextRef.current = analyticsContext;

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
    void bootstrapAction().then((state) => {
      if (requestEpochRef.current !== epoch) return;
      acceptBootstrap(state, requestStartedAt);
    });
  }, [acceptBootstrap, bootstrapAction]);

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
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      requestAbortRef.current?.abort();
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    };
  }, [reboot, revalidate]);

  useEffect(() => {
    const changed = () => setPresentationActive(document.fullscreenElement === pageRef.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  useEffect(() => {
    const changed = () => setVisibilityEpoch((current) => current + 1);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('focus', changed);
    window.addEventListener('resize', changed);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('focus', changed);
      window.removeEventListener('resize', changed);
    };
  }, []);

  const ready = accepted.state.state === 'ready' ? accepted.state : null;
  const resolved = useMemo(
    () => (ready === null ? null : resolvePublicSharePageV1(ready.projection, selectedPageId)),
    [ready, selectedPageId],
  );
  const mediaResolver = useMemo(
    () => (ready === null ? undefined : createPublicShareMediaResolverV1(ready)),
    [ready],
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
        <header className={styles.toolbar}>
          <strong>{ready.projection.title}</strong>
          <PresentationModeControls
            active={presentationActive}
            disabled={false}
            buttonRef={presentationButtonRef}
            onEnter={() => {
              const page = pageRef.current;
              if (page === null) return;
              void page
                .requestFullscreen()
                .then(() => setPresentationActive(true))
                .catch(() => {
                  setPresentationActive(true);
                  page.focus();
                });
            }}
            onExit={() => {
              if (document.fullscreenElement !== null)
                void document.exitFullscreen().catch(() => undefined);
              setPresentationActive(false);
            }}
          />
        </header>
        <article className={styles.reader}>
          <PresentationStage
            stageRef={(element) => {
              stageRef.current = element;
            }}
            mode={resolved.page.displayMode}
            canvasSize={null}
            toolbar={
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
              />
            }
            overlay={null}
            presentationActive={presentationActive}
            moveToggle={resolved.page.displayMode === 'actual-size'}
            moveIdentity={`${ready.context.contextId}:${resolved.pageId}`}
            onMoveAvailabilityChange={() => undefined}
            onMoveCaptureActiveChange={() => undefined}
            label={t('sharing.readerLabel')}
          >
            <h1 className={styles.heading}>{resolved.page.title}</h1>
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
            />
          </PresentationStage>
        </article>
      </div>
    </main>
  );
}
