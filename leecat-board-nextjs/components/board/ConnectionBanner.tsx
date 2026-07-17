'use client';

import type { BoardStreamStateV1 } from '@leecat-board/board-sdk/sse';
import { useI18n } from '../i18n/I18nProvider';

export function ConnectionBanner({ connection }: { connection: BoardStreamStateV1 }) {
  const { t } = useI18n();
  if (connection.state === 'live') return <div className="connection-state is-live" role="status"><span />{t('board.liveSequence', { number: connection.lastAppliedSequence })}</div>;
  if (connection.state === 'reconnecting') return <div className="connection-state is-warning" role="status"><span />{t('board.reconnecting')}</div>;
  if (connection.state === 'terminal') return <div className="connection-state is-error" role="alert"><span />{t('board.updatesStopped')}</div>;
  if (connection.state === 'reconciliation_required') return <div className="connection-state is-warning" role="alert"><span />{t('board.reconciliationRequired')}</div>;
  return <div className="connection-state" role="status"><span />{connection.state === 'connecting' ? t('board.connecting') : t('board.preparingUpdates')}</div>;
}
