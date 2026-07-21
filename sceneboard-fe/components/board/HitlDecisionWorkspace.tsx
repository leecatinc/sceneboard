'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/I18nProvider';

export function HitlDecisionWorkspace({
  children,
  label,
  preferExpanded,
}: {
  children: ReactNode;
  label: string;
  preferExpanded: boolean;
}) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(preferExpanded);

  useEffect(() => {
    if (preferExpanded) setIsExpanded(true);
  }, [preferExpanded]);

  useEffect(() => {
    if (!isExpanded) return undefined;
    const exitExpandedView = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsExpanded(false);
    };
    window.addEventListener('keydown', exitExpandedView);
    return () => window.removeEventListener('keydown', exitExpandedView);
  }, [isExpanded]);

  return (
    <section
      className={`board-hitl-overlay ${isExpanded ? 'is-expanded' : ''}`}
      aria-label={label}
      aria-live="polite"
    >
      <div className="board-hitl-tray">
        <header className="board-hitl-toolbar">
          <span>
            <strong>{t('hitl.decisionWorkspace')}</strong>
            <small>{t('hitl.reviewFullContext')}</small>
          </span>
          <button
            type="button"
            aria-pressed={isExpanded}
            onClick={() => setIsExpanded((current) => !current)}
          >
            {isExpanded ? t('hitl.standardView') : t('hitl.expand')}
          </button>
        </header>
        <div className="board-hitl-scroll">{children}</div>
      </div>
    </section>
  );
}
