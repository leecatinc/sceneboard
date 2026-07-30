'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BoardSnapshot, PresenceSummaryV1 } from '@sceneboard/board-schema';

import { useI18n } from '../i18n/I18nProvider';
import { deriveUtilityRailBadgesV1 } from '../../lib/board/utility-rail-badges';
import styles from './BoardUtilityRail.module.css';

type RailPanel = 'activity' | 'ai' | 'interactions' | 'artifacts' | 'access';

type PanelDef = {
  readonly id: RailPanel;
  readonly labelKey:
    | 'board.status'
    | 'board.aiPresence'
    | 'board.interactions'
    | 'board.artifacts'
    | 'presentation.boardControls';
};

// The access panel is only surfaced when owner-management controls are provided.
const ACCESS_PANEL: PanelDef = { id: 'access', labelKey: 'presentation.boardControls' };

const BASE_PANELS: readonly PanelDef[] = [
  { id: 'activity', labelKey: 'board.status' },
  { id: 'ai', labelKey: 'board.aiPresence' },
  { id: 'interactions', labelKey: 'board.interactions' },
  { id: 'artifacts', labelKey: 'board.artifacts' },
];

export function BoardUtilityRail({
  snapshot,
  presence,
  onStopRendering,
  presentationControl,
  viewControls,
  ownerAdmin,
}: {
  snapshot: BoardSnapshot;
  presence: readonly PresenceSummaryV1[];
  onStopRendering: () => void;
  presentationControl: ReactNode;
  viewControls: ReactNode;
  ownerAdmin?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<null | RailPanel>(null);
  const railRef = useRef<HTMLElement | null>(null);
  // The access panel is added conditionally with owner rights, so keep a stable trigger ref slot for every panel.
  const panels: readonly PanelDef[] = ownerAdmin ? [...BASE_PANELS, ACCESS_PANEL] : BASE_PANELS;
  const triggerRefs = useRef<Record<RailPanel, HTMLButtonElement | null>>({
    activity: null,
    ai: null,
    interactions: null,
    artifacts: null,
    access: null,
  });

  const openCount = snapshot.hitl.filter((item) => item.state === 'open').length;
  const artifactCount = snapshot.artifacts.length;
  const badges = deriveUtilityRailBadgesV1({
    aiCount: presence.length,
    interactionCount: openCount,
    artifactCount,
  });

  const closePanel = useCallback(
    (restoreFocus: boolean) => {
      const previouslyOpen = open;
      setOpen(null);
      if (restoreFocus && previouslyOpen !== null) {
        const trigger = triggerRefs.current[previouslyOpen];
        requestAnimationFrame(() => trigger?.focus());
      }
    },
    [open],
  );

  const toggle = useCallback((panel: RailPanel) => {
    setOpen((current) => {
      if (current === panel) return null;
      return panel;
    });
  }, []);

  // Only attach outside-click/Escape handling while a flyout is open.
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const rail = railRef.current;
      if (rail !== null && event.target instanceof Node && !rail.contains(event.target)) {
        closePanel(true);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closePanel, open]);

  // If owner rights vanish (downgrade/disconnect) while the access panel is open, close it so an empty flyout never lingers.
  useEffect(() => {
    if (open === 'access' && !ownerAdmin) setOpen(null);
  }, [open, ownerAdmin]);

  const badgeFor = (panel: RailPanel): number | null => {
    if (panel === 'ai') return badges.ai;
    if (panel === 'interactions') return badges.interactions;
    if (panel === 'artifacts') return badges.artifacts;
    return null;
  };

  const flyoutContent = (panel: RailPanel) => {
    if (panel === 'activity') {
      return (
        <section className={styles.section}>
          <h4>{t('board.viewMode')}</h4>
          <div className={styles.viewControls}>{viewControls}</div>
        </section>
      );
    }
    if (panel === 'ai') {
      return (
        <div className={styles.metric}>
          <span className={styles.metricLabel}>{t('board.aiPresence')}</span>
          <span className={styles.metricValue}>{presence.length}</span>
        </div>
      );
    }
    if (panel === 'interactions') {
      return (
        <div className={styles.metric}>
          <span className={styles.metricLabel}>{t('board.interactions')}</span>
          <span className={styles.metricValue}>{openCount}</span>
        </div>
      );
    }
    // The access flyout exposes the owner-only share/member and destructive management controls.
    if (panel === 'access') {
      return <div className={styles.management}>{ownerAdmin}</div>;
    }
    return (
      <>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>{t('board.artifacts')}</span>
          <span className={styles.metricValue}>{artifactCount}</span>
        </div>
        {artifactCount > 0 && (
          <button type="button" className={styles.stop} onClick={onStopRendering}>
            {t('board.stopRendering')}
          </button>
        )}
      </>
    );
  };

  return (
    <aside className={styles.rail} ref={railRef} aria-label={t('board.status')}>
      <div className={styles.presentationAction}>{presentationControl}</div>
      <div className={styles.separator} aria-hidden="true" />
      {panels.map((panel) => {
        const isOpen = open === panel.id;
        const badge = badgeFor(panel.id);
        const controlsId = `board-utility-flyout-${panel.id}`;
        return (
          <button
            key={panel.id}
            ref={(element) => {
              triggerRefs.current[panel.id] = element;
            }}
            type="button"
            className={styles.button}
            aria-expanded={isOpen}
            aria-controls={controlsId}
            aria-label={t(panel.labelKey)}
            title={t(panel.labelKey)}
            onClick={() => toggle(panel.id)}
          >
            <PanelIcon panel={panel.id} />
            {badge !== null && <span className={styles.badge}>{badge}</span>}
          </button>
        );
      })}
      {open !== null && (
        <div
          id={`board-utility-flyout-${open}`}
          className={styles.flyout}
          role="group"
          aria-label={t(panels.find((panel) => panel.id === open)?.labelKey ?? 'board.status')}
        >
          <div className={styles.flyoutHeader}>
            <h3>{t(panels.find((panel) => panel.id === open)?.labelKey ?? 'board.status')}</h3>
            <button
              type="button"
              className={styles.close}
              aria-label={t('sharing.close')}
              onClick={() => closePanel(true)}
            >
              ×
            </button>
          </div>
          <div className={styles.flyoutBody}>{flyoutContent(open)}</div>
        </div>
      )}
    </aside>
  );
}

function PanelIcon({ panel }: { panel: RailPanel }) {
  if (panel === 'activity') {
    return (
      <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 6h16M4 12h16M4 18h10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (panel === 'ai') {
    return (
      <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3l1.8 4.6L18.5 9.4l-4.7 1.8L12 15.8l-1.8-4.6L5.5 9.4l4.7-1.8L12 3z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (panel === 'interactions') {
    return (
      <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 5h16v10H8l-4 4V5z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (panel === 'access') {
    return (
      <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="9" cy="10" r="3.2" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M11.6 12.2L19 19.6M16 16.6l2-2M18.4 18.8l1.8-1.8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
