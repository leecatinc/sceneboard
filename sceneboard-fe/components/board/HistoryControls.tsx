'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { RevisionId } from '@sceneboard/board-schema';
import type { LiveBoardStateV1 } from '@sceneboard/board-sdk/state';

import type { RetainedHistoryDropdownV1 } from '../../lib/board/use-board-session';
import { useI18n } from '../i18n/I18nProvider';

const LISTBOX_ID = 'history-revision-listbox';

export function HistoryControls({
  state,
  liveUpdated,
  history,
  onOpen,
  onClose,
  onLoadMore,
  onRetry,
  onSelectRevision,
  onSelectLatest,
  variant = 'combobox',
}: {
  state: LiveBoardStateV1;
  liveUpdated: boolean;
  history: RetainedHistoryDropdownV1;
  onOpen: () => void;
  onClose: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelectRevision: (revisionId: RevisionId) => void;
  onSelectLatest: () => void;
  variant?: 'combobox' | 'sidebar';
}) {
  const { locale, t, formatDateTime } = useI18n();
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const selectedRevisionId =
    state.mode.kind === 'history' ? state.mode.snapshot.revision.revisionId : null;
  const selectedIndex = useMemo(() => {
    if (selectedRevisionId === null) return 0;
    const index = history.rows.findIndex((row) => row.revisionId === selectedRevisionId);
    return index < 0 ? 0 : index + 1;
  }, [history.rows, selectedRevisionId]);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const optionCount = history.rows.length + 1;
  const currentActiveIndex = Math.min(activeIndex, optionCount - 1);
  const latestLabel = t('board.historyLatestRevision', {
    number: new Intl.NumberFormat(locale).format(state.liveSnapshot.revision.revisionNumber),
  });
  const selectedLabel =
    selectedRevisionId === null
      ? latestLabel
      : (history.rows.find((row) => row.revisionId === selectedRevisionId)?.label ??
        t('boards.revision', {
          number: state.mode.kind === 'history' ? state.mode.snapshot.revision.revisionNumber : '',
        }));

  useEffect(() => {
    if (variant !== 'sidebar') return;
    onOpen();
    return onClose;
  }, [onClose, onOpen, variant]);

  useEffect(() => {
    if (history.isOpen) setActiveIndex(Math.min(selectedIndex, optionCount - 1));
  }, [history.isOpen, optionCount, selectedIndex]);

  useEffect(() => {
    if (variant === 'sidebar' || !history.isOpen) return;
    const dismiss = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      onClose();
      if (!(event.target instanceof HTMLElement) || event.target.tabIndex < 0)
        triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [history.isOpen, onClose, variant]);

  const select = (index: number) => {
    if (index === 0) onSelectLatest();
    else {
      const row = history.rows[index - 1];
      if (row !== undefined) onSelectRevision(row.revisionId);
    }
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (state.pendingNavigation) {
      event.preventDefault();
      return;
    }
    const opens =
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === ' ';
    if (!history.isOpen) {
      if (!opens) return;
      event.preventDefault();
      setActiveIndex(selectedIndex);
      onOpen();
      return;
    }
    if (event.key === 'Tab') {
      if (history.status === 'error' && !event.shiftKey) return;
      onClose();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'PageDown') {
      event.preventDefault();
      onLoadMore();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : optionCount - 1);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) =>
        event.key === 'ArrowDown'
          ? Math.min(optionCount - 1, current + 1)
          : Math.max(0, current - 1),
      );
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(currentActiveIndex);
    }
  };

  const retry = () => {
    onRetry();
    triggerRef.current?.focus();
  };
  const announcement =
    history.announcement === 'history_unavailable'
      ? t('board.historyUnavailable')
      : history.announcement === 'selected_unavailable'
        ? t('board.historySelectionUnavailable')
        : liveUpdated
          ? t('board.liveUpdated')
          : '';

  if (variant === 'sidebar') {
    const retainedRows = history.rows.filter(
      (row) => row.revisionId !== state.liveSnapshot.revision.revisionId,
    );
    return (
      <nav
        className="history-controls history-sidebar"
        aria-label={t('board.historyLabel')}
        aria-busy={history.status === 'loading' || history.status === 'loading_more'}
      >
        <button
          type="button"
          className="history-sidebar-latest"
          aria-pressed={selectedRevisionId === null}
          disabled={state.pendingNavigation}
          onClick={onSelectLatest}
        >
          {t('presentation.goToLatest')}
        </button>
        <ol className="history-sidebar-list">
          <li>
            <button
              type="button"
              aria-pressed={selectedRevisionId === null}
              disabled={state.pendingNavigation}
              onClick={onSelectLatest}
            >
              <strong>{latestLabel}</strong>
              {liveUpdated && <span>{t('board.liveUpdated')}</span>}
            </button>
          </li>
          {retainedRows.map((row) => (
            <li key={row.revisionId}>
              <button
                type="button"
                aria-pressed={selectedRevisionId === row.revisionId}
                disabled={state.pendingNavigation}
                onClick={() => onSelectRevision(row.revisionId)}
              >
                <strong>{row.label}</strong>
                <span>
                  {formatDateTime(row.createdAt)} · {t(`board.historyActor.${row.actorLabel}`)}
                </span>
                <span>{t(`board.historySummary.${row.summary}`)}</span>
              </button>
            </li>
          ))}
        </ol>
        {(history.status === 'loading' || history.status === 'loading_more') && (
          <p className="history-popup-state">{t('board.historyLoading')}</p>
        )}
        {history.status === 'error' && (
          <div className="history-popup-state">
            <p>{t('board.historyUnavailable')}</p>
            <button ref={retryRef} type="button" onClick={retry}>
              {t('board.historyRetry')}
            </button>
          </div>
        )}
        {history.status === 'ready' && retainedRows.length === 0 && history.nextCursor === null && (
          <p className="history-popup-state">{t('board.historyEmpty')}</p>
        )}
        {history.nextCursor !== null && history.status === 'ready' && (
          <button type="button" className="history-load-more" onClick={onLoadMore}>
            {t('board.historyLoadMore')}
          </button>
        )}
        <span className="history-live-region visually-hidden" role="status" aria-live="polite">
          {state.pendingNavigation ? t('board.loadingRevision') : announcement}
        </span>
      </nav>
    );
  }

  return (
    <nav ref={rootRef} className="history-controls" aria-label={t('board.historyLabel')}>
      <div className="history-combobox">
        <button
          ref={triggerRef}
          type="button"
          className={`history-trigger${history.status === 'error' ? ' is-warning' : ''}`}
          role="combobox"
          aria-label={`${t('board.historyLabel')}: ${selectedLabel}`}
          aria-expanded={history.isOpen}
          aria-controls={LISTBOX_ID}
          aria-activedescendant={
            history.isOpen ? `history-revision-option-${currentActiveIndex}` : undefined
          }
          aria-disabled={state.pendingNavigation}
          aria-busy={history.status === 'loading' || history.status === 'loading_more'}
          onClick={() => {
            if (state.pendingNavigation) return;
            if (history.isOpen) onClose();
            else onOpen();
          }}
          onKeyDown={onTriggerKeyDown}
        >
          <span>{selectedLabel}</span>
          <span
            aria-hidden="true"
            className={`history-trigger-caret${history.status === 'error' ? ' is-warning' : ''}`}
          >
            ▾
          </span>
        </button>
        {history.isOpen && (
          <div className="history-popup">
            <div id={LISTBOX_ID} role="listbox" aria-label={t('board.historyLabel')}>
              <button
                id="history-revision-option-0"
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selectedIndex === 0}
                className={currentActiveIndex === 0 ? 'is-active' : undefined}
                onPointerMove={() => setActiveIndex(0)}
                onClick={() => select(0)}
              >
                <strong>{latestLabel}</strong>
              </button>
              {history.rows.map((row, index) => {
                const optionIndex = index + 1;
                return (
                  <button
                    id={`history-revision-option-${optionIndex}`}
                    key={row.revisionId}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selectedIndex === optionIndex}
                    className={currentActiveIndex === optionIndex ? 'is-active' : undefined}
                    onPointerMove={() => setActiveIndex(optionIndex)}
                    onClick={() => select(optionIndex)}
                  >
                    <strong>{row.label}</strong>
                    <span>
                      {formatDateTime(row.createdAt)} · {t(`board.historyActor.${row.actorLabel}`)}
                    </span>
                    <span>{t(`board.historySummary.${row.summary}`)}</span>
                  </button>
                );
              })}
            </div>
            {(history.status === 'loading' || history.status === 'loading_more') && (
              <p className="history-popup-state">{t('board.historyLoading')}</p>
            )}
            {history.status === 'error' && (
              <div className="history-popup-state">
                <p>{t('board.historyUnavailable')}</p>
                <button ref={retryRef} type="button" onClick={retry}>
                  {t('board.historyRetry')}
                </button>
              </div>
            )}
            {history.status === 'ready' &&
              history.rows.length === 0 &&
              history.nextCursor === null && (
                <p className="history-popup-state">{t('board.historyEmpty')}</p>
              )}
            {history.nextCursor !== null && history.status === 'ready' && (
              <button type="button" className="history-load-more" onClick={onLoadMore}>
                {t('board.historyLoadMore')}
              </button>
            )}
          </div>
        )}
      </div>
      <span className="history-live-region visually-hidden" role="status" aria-live="polite">
        {state.pendingNavigation ? t('board.loadingRevision') : announcement}
      </span>
    </nav>
  );
}
