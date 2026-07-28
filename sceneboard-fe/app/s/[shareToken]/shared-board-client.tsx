'use client';

import type { PageId } from '@sceneboard/board-schema';
import { PublicBoardRenderer } from '@sceneboard/board-ui/renderer';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { PageNavigationControls } from '../../../components/board/PageNavigationControls';
import { PresentationModeControls } from '../../../components/board/PresentationModeControls';
import { PresentationStage } from '../../../components/board/PresentationStage';
import { useI18n } from '../../../components/i18n/I18nProvider';
import { fetchPublicShareRevalidation } from '../../../lib/api/public-share-contract';
import { navigatePageIdV1 } from '../../../lib/board/page-navigation';
import { resolvePublicSharePageV1 } from '../../../lib/board/public-page-render-adapter';
import {
  publicShareProjectionTupleMatchesV1,
  publicShareViewerDeadlinesV1,
  publicShareViewerIdentityV1,
  samePublicShareViewerIdentityV1,
} from '../../../lib/board/public-share-viewer-state';
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
  const [isPending, startTransition] = useTransition();
  const stateRef = useRef(accepted);
  const requestEpochRef = useRef(0);
  const routeEpochRef = useRef(crypto.randomUUID());
  const requestAbortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const presentationButtonRef = useRef<HTMLButtonElement | null>(null);
  stateRef.current = accepted;

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

  const ready = accepted.state.state === 'ready' ? accepted.state : null;
  const resolved = useMemo(
    () => (ready === null ? null : resolvePublicSharePageV1(ready.projection, selectedPageId)),
    [ready, selectedPageId],
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
                  setSelectedPageId(
                    navigatePageIdV1(ready.projection.document, resolved.pageId, 'previous'),
                  )
                }
                onNext={() =>
                  setSelectedPageId(
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
              page={resolved.page}
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
            />
          </PresentationStage>
        </article>
      </div>
    </main>
  );
}
