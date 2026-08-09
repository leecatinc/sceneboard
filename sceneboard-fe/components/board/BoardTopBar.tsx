'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import styles from './BoardTopBar.module.css';

export function BoardTopBar({
  boardIdentity,
  mediaAuthoring,
  pageNavigation,
  viewControls,
  revision,
  connections,
}: {
  boardIdentity: ReactNode;
  mediaAuthoring: ReactNode;
  pageNavigation: ReactNode;
  viewControls: ReactNode;
  revision: ReactNode;
  connections: ReactNode;
}) {
  const { t } = useI18n();
  const [mediaOpen, setMediaOpen] = useState(false);
  const mediaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mediaOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !mediaRef.current?.contains(event.target)) {
        setMediaOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMediaOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mediaOpen]);

  return (
    <header className="board-topbar">
      <div className="board-topbar-leading">
        <div className="board-topbar-identity">{boardIdentity}</div>
        {mediaAuthoring !== null && (
          <div ref={mediaRef} className={`board-topbar-media-authoring ${styles.media}`}>
            <button
              type="button"
              className={`button secondary ${styles.mediaTrigger}`}
              aria-expanded={mediaOpen}
              aria-controls="board-media-authoring-popover"
              onClick={() => setMediaOpen((current) => !current)}
            >
              {t('mediaAuthoring.ready')}
            </button>
            <section
              id="board-media-authoring-popover"
              className={styles.mediaPopover}
              aria-label={t('mediaAuthoring.ready')}
              hidden={!mediaOpen}
            >
              <header className={styles.mediaPopoverHeader}>
                <strong>{t('mediaAuthoring.ready')}</strong>
                <button
                  type="button"
                  className={styles.mediaClose}
                  aria-label={t('sharing.close')}
                  onClick={() => setMediaOpen(false)}
                >
                  ×
                </button>
              </header>
              <div className={styles.mediaPopoverBody}>{mediaAuthoring}</div>
            </section>
          </div>
        )}
      </div>
      <div className={styles.center}>
        <div className="board-topbar-page-navigation">{pageNavigation}</div>
        {viewControls !== null && <div className={styles.viewControls}>{viewControls}</div>}
      </div>
      <div className="board-topbar-actions">
        <div className="board-topbar-revision">{revision}</div>
        <div className="board-topbar-connections">{connections}</div>
      </div>
    </header>
  );
}
