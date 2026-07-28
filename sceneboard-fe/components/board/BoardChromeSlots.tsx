'use client';

import type { ReactNode } from 'react';
import type { RevisionId } from '@sceneboard/board-schema';
import type { LiveBoardStateV1 } from '@sceneboard/board-sdk/state';
import type { ArtifactViewModeV1 } from '@sceneboard/board-ui/artifact';

import type { RetainedHistoryDropdownV1 } from '../../lib/board/use-board-session';
import { useI18n } from '../i18n/I18nProvider';
import { BoardTitleEditor } from './BoardTitleEditor';
import { BoardViewModeControls } from './BoardViewModeControls';
import { ConnectionBanner } from './ConnectionBanner';
import { HistoryControls } from './HistoryControls';

export function BoardIdentitySlot({
  title,
  state,
  onRename,
  canRename,
}: {
  title: string;
  state: LiveBoardStateV1;
  onRename: (title: string) => Promise<boolean>;
  canRename: boolean;
}) {
  const { t } = useI18n();
  const snapshot = state.mode.kind === 'history' ? state.mode.snapshot : state.liveSnapshot;
  return (
    <>
      <p className="eyebrow">
        {state.mode.kind === 'history' ? t('board.historicalView') : t('board.liveScene')}
      </p>
      <BoardTitleEditor title={title} onRename={onRename} enabled={canRename} />
      <p>{t('boards.revision', { number: snapshot.revision.revisionNumber })}</p>
    </>
  );
}

export function BoardConnectionsSlot({
  state,
  pairingControl,
}: {
  state: LiveBoardStateV1;
  pairingControl: ReactNode;
}) {
  return (
    <div className="board-connection-actions">
      <ConnectionBanner connection={state.connection} />
      {pairingControl}
    </div>
  );
}

export function BoardHistorySlot({
  state,
  liveUpdated,
  viewMode,
  artifactZoom,
  canResetArtifactView,
  onViewModeChange,
  onResetArtifactView,
  history,
  onOpenHistory,
  onCloseHistory,
  onLoadMoreHistory,
  onRetryHistory,
  onSelectHistoryRevision,
  onSelectLatestHistory,
}: {
  state: LiveBoardStateV1;
  liveUpdated: boolean;
  viewMode: ArtifactViewModeV1;
  artifactZoom: number | null;
  canResetArtifactView: boolean;
  onViewModeChange: (mode: ArtifactViewModeV1) => void;
  onResetArtifactView: () => void;
  history: RetainedHistoryDropdownV1;
  onOpenHistory: () => void;
  onCloseHistory: () => void;
  onLoadMoreHistory: () => void;
  onRetryHistory: () => void;
  onSelectHistoryRevision: (revisionId: RevisionId) => void;
  onSelectLatestHistory: () => void;
}) {
  return (
    <div className="board-navigation-actions">
      <BoardViewModeControls
        value={viewMode}
        zoom={artifactZoom}
        canReset={canResetArtifactView}
        onChange={onViewModeChange}
        onReset={onResetArtifactView}
      />
      <HistoryControls
        state={state}
        liveUpdated={liveUpdated}
        history={history}
        onOpen={onOpenHistory}
        onClose={onCloseHistory}
        onLoadMore={onLoadMoreHistory}
        onRetry={onRetryHistory}
        onSelectRevision={onSelectHistoryRevision}
        onSelectLatest={onSelectLatestHistory}
      />
    </div>
  );
}
