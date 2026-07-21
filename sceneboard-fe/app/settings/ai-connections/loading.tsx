'use client';

import { useI18n } from '../../../components/i18n/I18nProvider';

export default function Loading() {
  const { t } = useI18n();
  return (
    <main className="settings">
      <p className="muted">{t('ai.loadingConnections')}</p>
    </main>
  );
}
