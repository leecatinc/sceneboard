'use client';

import { useI18n } from '../../components/i18n/I18nProvider';

export default function Loading() {
  const { t } = useI18n();
  return <main id="main-content" className="route-state" role="status"><span className="spinner" />{t('error.loadingBoards')}</main>;
}
