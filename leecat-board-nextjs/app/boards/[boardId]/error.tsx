'use client';

import Link from 'next/link';
import { useI18n } from '../../../components/i18n/I18nProvider';

export default function BoardError({ reset }: { error: Error; reset: () => void }) {
  const { t } = useI18n();
  return <main id="main-content" className="route-state"><h1>{t('error.boardRouteStopped')}</h1><p>{t('error.noPayloadExposed')}</p><div className="actions"><button className="button" onClick={reset}>{t('common.retry')}</button><Link className="button secondary link-button" href="/boards">{t('board.backToBoards')}</Link></div></main>;
}
