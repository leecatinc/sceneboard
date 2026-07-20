'use client';

import type { ReactNode } from 'react';
import type { LiveBoardStateV1 } from '@leecat-board/board-sdk/state';
import type { ArtifactViewModeV1 } from '@leecat-board/board-ui/artifact';
import { useI18n } from '../i18n/I18nProvider';
import { ConnectionBanner } from './ConnectionBanner';
import { HistoryControls } from './HistoryControls';
import { BoardTitleEditor } from './BoardTitleEditor';
import { BoardViewModeControls } from './BoardViewModeControls';

export function BoardTopBar({ title, state, liveUpdated, pairingControl, archiveControl, viewMode, artifactZoom, canResetArtifactView, onViewModeChange, onResetArtifactView, onRename, onPrevious, onNext, onLatest }: {
  title: string;
  state: LiveBoardStateV1;
  liveUpdated: boolean;
  pairingControl: ReactNode;
  archiveControl: ReactNode;
  viewMode: ArtifactViewModeV1;
  artifactZoom: number | null;
  canResetArtifactView: boolean;
  onViewModeChange: (mode: ArtifactViewModeV1) => void;
  onResetArtifactView: () => void;
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
      <div className="board-connection-actions"><ConnectionBanner connection={state.connection} />{pairingControl}{archiveControl}</div>
      <div className="board-navigation-actions"><BoardViewModeControls value={viewMode} zoom={artifactZoom} canReset={canResetArtifactView} onChange={onViewModeChange} onReset={onResetArtifactView} /><HistoryControls state={state} liveUpdated={liveUpdated} onPrevious={onPrevious} onNext={onNext} onLatest={onLatest} /></div>
    </header>
  );
}
