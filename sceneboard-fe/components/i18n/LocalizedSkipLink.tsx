'use client';

import { useI18n } from './I18nProvider';

export function LocalizedSkipLink() {
  const { t } = useI18n();
  return (
    <a className="skip-link" href="#main-content">
      {t('common.skip')}
    </a>
  );
}
