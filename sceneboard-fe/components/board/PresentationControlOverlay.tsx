'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import {
  activityPresentationControlsV1,
  createPresentationControlVisibilityV1,
  elapsePresentationControlsV1,
  updatePresentationControlHoldsV1,
  type PresentationControlVisibilityInputV1,
  type PresentationControlVisibilityStateV1,
} from '../../lib/board/presentation-control-visibility';
import styles from './PresentationControlOverlay.module.css';

export function PresentationControlOverlay({
  active,
  activitySignal,
  current,
  total,
  dialogOrMenuOpen,
  hitlInteractionActive,
  artifactCaptureActive,
  moveCaptureActive,
  additionalControls,
  onPrevious,
  onNext,
  onExit,
}: {
  active: boolean;
  activitySignal: number;
  current: number;
  total: number;
  dialogOrMenuOpen: boolean;
  hitlInteractionActive: boolean;
  artifactCaptureActive: boolean;
  moveCaptureActive: boolean;
  additionalControls: ReactNode;
  onPrevious: () => void;
  onNext: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const [controlsFocusWithin, setControlsFocusWithin] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [visibility, setVisibility] = useState(createPresentationControlVisibilityV1);
  const visibilityRef = useRef(visibility);
  const inputRef = useRef<PresentationControlVisibilityInputV1 | null>(null);
  const priorInputRef = useRef<PresentationControlVisibilityInputV1 | null>(null);
  const priorActivitySignalRef = useRef(activitySignal);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstControlRef = useRef<HTMLButtonElement | null>(null);
  const input = useMemo<PresentationControlVisibilityInputV1>(
    () => ({
      controlsFocusWithin,
      dialogOrMenuOpen,
      hitlInteractionActive,
      artifactCaptureActive,
      moveCaptureActive,
      prefersReducedMotion,
    }),
    [
      artifactCaptureActive,
      controlsFocusWithin,
      dialogOrMenuOpen,
      hitlInteractionActive,
      moveCaptureActive,
      prefersReducedMotion,
    ],
  );
  inputRef.current = input;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const commit = useCallback(
    (next: PresentationControlVisibilityStateV1) => {
      clearTimer();
      visibilityRef.current = next;
      setVisibility(next);
      if (next.phase === 'pending-hide' && next.deadlineMs !== null) {
        const generation = next.generation;
        timerRef.current = setTimeout(
          () => {
            const currentInput = inputRef.current;
            if (currentInput === null) return;
            const elapsed = elapsePresentationControlsV1(
              visibilityRef.current,
              currentInput,
              generation,
              Date.now(),
            );
            visibilityRef.current = elapsed;
            setVisibility(elapsed);
            timerRef.current = null;
          },
          Math.max(0, next.deadlineMs - Date.now()),
        );
      }
    },
    [clearTimer],
  );
  const recordActivity = useCallback(() => {
    commit(activityPresentationControlsV1(visibilityRef.current, input, Date.now()));
  }, [commit, input]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPrefersReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!active) {
      clearTimer();
      const initial = createPresentationControlVisibilityV1();
      visibilityRef.current = initial;
      setVisibility(initial);
      priorInputRef.current = input;
      return;
    }
    const previous = priorInputRef.current ?? input;
    priorInputRef.current = input;
    const next = updatePresentationControlHoldsV1(
      visibilityRef.current,
      previous,
      input,
      Date.now(),
    );
    if (next !== visibilityRef.current) commit(next);
  }, [active, clearTimer, commit, input]);
  useEffect(() => {
    const previous = priorActivitySignalRef.current;
    priorActivitySignalRef.current = activitySignal;
    if (active && previous !== activitySignal) recordActivity();
  }, [active, activitySignal, recordActivity]);
  useEffect(() => {
    if (!active || visibility.phase !== 'hidden') return;
    const revealOnFirstTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      event.preventDefault();
      recordActivity();
      requestAnimationFrame(() => firstControlRef.current?.focus());
    };
    window.addEventListener('keydown', revealOnFirstTab, true);
    return () => window.removeEventListener('keydown', revealOnFirstTab, true);
  }, [active, recordActivity, visibility.phase]);
  useEffect(() => clearTimer, [clearTimer]);

  if (!active) return null;
  return (
    <div className={styles.overlay} data-presentation-controls={visibility.phase}>
      <div
        className={styles.panel}
        role="group"
        aria-label={t('presentation.presentationControls')}
        onPointerMove={recordActivity}
        onFocusCapture={() => setControlsFocusWithin(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setControlsFocusWithin(false);
        }}
      >
        <button
          ref={firstControlRef}
          type="button"
          disabled={current <= 1}
          aria-label={t('presentation.previousPage')}
          onClick={() => {
            recordActivity();
            onPrevious();
          }}
        >
          ‹
        </button>
        <output aria-live="polite">
          {current} / {total}
        </output>
        <button
          type="button"
          disabled={current >= total}
          aria-label={t('presentation.nextPage')}
          onClick={() => {
            recordActivity();
            onNext();
          }}
        >
          ›
        </button>
        {additionalControls}
        <button type="button" onClick={onExit}>
          {t('presentation.exitPresentation')}
        </button>
      </div>
      {visibility.phase === 'hidden' && (
        <div
          className={styles.revealZone}
          aria-hidden="true"
          onPointerEnter={recordActivity}
          onPointerDown={recordActivity}
        />
      )}
    </div>
  );
}
