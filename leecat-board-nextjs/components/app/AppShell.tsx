'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import type { MessageKey } from '../../lib/i18n/catalog';
import { useI18n } from '../i18n/I18nProvider';
import { Brand } from './Brand';
import { UserMenu } from './UserMenu';

export function AppShell({ children, titleKey, actions, viewportLocked = false }: {
  children: ReactNode;
  titleKey: MessageKey;
  actions?: ReactNode;
  viewportLocked?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={`app-shell${viewportLocked ? ' app-shell-viewport-locked' : ''}`}>
      <header className="app-header">
        <Brand linked label={t('brand.boardsLabel')} />
        <nav className="app-nav" aria-label={t('nav.primary')}>
          <Link href="/boards">{t('nav.boards')}</Link>
          <Link href="/settings/ai-connections">{t('nav.aiConnections')}</Link>
        </nav>
        <div className="app-header-actions">{actions}<UserMenu /></div>
      </header>
      <main id="main-content" className="app-main">
        <h1 className="visually-hidden">{t(titleKey)}</h1>
        {children}
      </main>
    </div>
  );
}
