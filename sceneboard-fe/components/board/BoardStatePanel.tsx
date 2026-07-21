'use client';

import Link from 'next/link';
import type { SafeBoardUiErrorV1 } from '@sceneboard/board-sdk/client';
import { useI18n } from '../i18n/I18nProvider';

export function BoardStatePanel({
  error,
  onRetry,
}: {
  error: SafeBoardUiErrorV1;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="route-state">
      <span className="state-icon" aria-hidden="true">
        ◇
      </span>
      <h2>
        {error.kind === 'not_found'
          ? t('board.notFound')
          : error.kind === 'forbidden'
            ? t('board.unavailable')
            : t('board.sceneUnavailable')}
      </h2>
      <p>{error.message}</p>
      <div className="actions">
        {error.retryable && (
          <button className="button" onClick={onRetry}>
            {t('common.retry')}
          </button>
        )}
        <Link className="button secondary link-button" href="/boards">
          {t('board.backToBoards')}
        </Link>
      </div>
    </section>
  );
}
