'use client';

import type { ReactNode } from 'react';
import type { LiveBoardStateV1 } from '@leecat-board/board-sdk/state';
import { useI18n } from '../i18n/I18nProvider';
import { ConnectionBanner } from './ConnectionBanner';
import { HistoryControls } from './HistoryControls';
import { BoardTitleEditor } from './BoardTitleEditor';

export function BoardTopBar({ title, state, liveUpdated, pairingControl, onRename, onPrevious, onNext, onLatest }: {
  title: string;
  state: LiveBoardStateV1;
  liveUpdated: boolean;
  pairingControl: ReactNode;
  onRename: (title: string) => Promise<boolean>;
  onPrevious: () => void;
  onNext: () => void;
  onLatest: () => void;
}) {
  const { t } = useI18n();
  const snapshot = state.mode.kind === 'history' ? state.mode.snapshot : state.liveSnapshot;
  return (
    <header className="board-topbar">
      <div><p className="eyebrow">{state.mode.kind === 'history' ? t('board.historicalView') : t('board.liveScene')}</p><BoardTitleEditor title={title} onRename={onRename} /><p>{t('boards.revision', { number: snapshot.revision.revisionNumber })}</p></div>
      <div className="board-connection-actions"><ConnectionBanner connection={state.connection} />{pairingControl}</div>
      <HistoryControls state={state} liveUpdated={liveUpdated} onPrevious={onPrevious} onNext={onNext} onLatest={onLatest} />
    </header>
  );
}
