'use client';

import { useI18n } from '../../../components/i18n/I18nProvider';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const { t } = useI18n();
  return (
    <main className="settings">
      <h1 className="page-title">{t('ai.settingsUnavailable')}</h1>
      <p className="muted">{t('ai.noCredentialStored')}</p>
      <button className="button secondary" onClick={reset}>
        {t('common.retry')}
      </button>
    </main>
  );
}
