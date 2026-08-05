'use client';

import type { PublicPresentationSessionSummaryV1 } from '@sceneboard/board-schema';
import { useEffect, useRef } from 'react';

import { useI18n } from '../../../components/i18n/I18nProvider';
import styles from './public-presentation-session-dialog.module.css';

export function PublicPresentationSessionDialog({
  open,
  busy,
  sessions,
  error,
  onClose,
  onRefresh,
  onStart,
  onJoin,
}: {
  open: boolean;
  busy: boolean;
  sessions: readonly PublicPresentationSessionSummaryV1[];
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onStart: () => void;
  onJoin: (sessionId: string) => void;
}) {
  const { t, formatDateTime } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || dialog === null) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      previous?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div
      className={styles.backdrop}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-presentation-session-title"
      >
        <div className={styles.header}>
          <h2 id="public-presentation-session-title">{t('presentation.liveSessionTitle')}</h2>
          <button className={styles.close} type="button" onClick={onClose}>
            {t('common.dismiss')}
          </button>
        </div>
        <p className={styles.description}>{t('presentation.liveSessionDescription')}</p>
        <button className={styles.primary} type="button" disabled={busy} onClick={onStart}>
          {t('presentation.startNewSession')}
        </button>
        <section>
          <div className={styles.sectionHeader}>
            <h3>{t('presentation.joinActiveSession')}</h3>
            <button className={styles.secondary} type="button" disabled={busy} onClick={onRefresh}>
              {t('presentation.refreshSessions')}
            </button>
          </div>
          {sessions.length === 0 ? (
            <p className={styles.empty}>{t('presentation.noActiveSessions')}</p>
          ) : (
            <ul className={styles.sessionList}>
              {sessions.map((session, index) => (
                <li key={session.sessionId}>
                  <button
                    className={styles.session}
                    type="button"
                    disabled={busy}
                    onClick={() => onJoin(session.sessionId)}
                  >
                    <span>
                      {t('presentation.sessionLabel', { number: sessions.length - index })}
                    </span>
                    <span>{formatDateTime(session.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className={styles.status} aria-live="polite" aria-atomic="true">
          {busy ? t('presentation.liveSessionConnecting') : null}
          {error === null ? null : <p className={styles.error}>{error}</p>}
        </div>
      </div>
    </div>
  );
}
