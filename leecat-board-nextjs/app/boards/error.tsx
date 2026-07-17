'use client';

import { useI18n } from '../../components/i18n/I18nProvider';

export default function BoardsError({ reset }: { error: Error; reset: () => void }) {
  const { t } = useI18n();
  return <main id="main-content" className="route-state"><h1>{t('error.boardsUnavailable')}</h1><p>{t('error.safeRender')}</p><button className="button" onClick={reset}>{t('common.retry')}</button></main>;
}
