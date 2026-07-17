'use client';

import type { LiveBoardStateV1 } from '@leecat-board/board-sdk/state';
import { useI18n } from '../i18n/I18nProvider';

export function HistoryControls({ state, liveUpdated, onPrevious, onNext, onLatest }: {
  state: LiveBoardStateV1;
  liveUpdated: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onLatest: () => void;
}) {
  const { t } = useI18n();
  const previousDisabled = state.pendingNavigation || (state.mode.kind === 'history' ? state.mode.navigation.previousRevisionId === null : state.liveSnapshot.revision.previousRevisionId === null);
  const nextDisabled = state.pendingNavigation || state.mode.kind !== 'history' || state.mode.navigation.nextRevisionId === null;
  return (
    <nav className="history-controls" aria-label={t('board.historyLabel')}>
      <button type="button" onClick={onPrevious} disabled={previousDisabled}>{t('board.previous')}</button>
      <button type="button" onClick={onNext} disabled={nextDisabled}>{t('board.next')}</button>
      <button type="button" className="latest-button" onClick={onLatest} disabled={state.pendingNavigation || state.mode.kind === 'live'}>{t('board.latest')}</button>
      {state.pendingNavigation && <span role="status">{t('board.loadingRevision')}</span>}
      {liveUpdated && <span className="live-updated" role="status">{t('board.liveUpdated')}</span>}
    </nav>
  );
}
