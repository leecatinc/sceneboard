'use client';

import { useI18n } from './I18nProvider';

export function LocalizedNotFound() {
  const { t } = useI18n();

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        gap: '0.5rem',
      }}
    >
      <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>404</h1>
      <p>{t('error.pageNotFound')}</p>
    </main>
  );
}
