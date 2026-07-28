'use client';

import { useI18n } from '../../../components/i18n/I18nProvider';

export default function SharedBoardLoading() {
  const { t } = useI18n();
  return (
    <main aria-busy="true">
      <p>{t('common.loading')}</p>
    </main>
  );
}
