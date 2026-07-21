'use client';

import type { BoardSummaryV1 } from '@sceneboard/board-schema';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { BoardApiClient } from '../../lib/api/board-api';
import {
  boardIdFromDetailPath,
  isBoardCreationAutoOpenPath,
  selectNewBoard,
  shouldLeaveCurrentBoard,
} from '../../lib/board/board-lifecycle-navigation';
import { authSessionClient } from '../../lib/auth/session-client';
import { useI18n } from '../i18n/I18nProvider';
import { ConfirmationDialog } from './ConfirmationDialog';

const POLL_INTERVAL_MS = 2_000;

export function BoardLifecycleNavigator() {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const [pendingBoard, setPendingBoard] = useState<BoardSummaryV1 | null>(null);
  const api = useMemo(() => new BoardApiClient(authSessionClient().sharedCoordinator()), []);

  useEffect(() => setPendingBoard(null), [pathname]);

  useEffect(() => {
    const currentPathname = pathname ?? '';
    const autoOpensCreation = isBoardCreationAutoOpenPath(currentPathname);
    const currentBoardId = boardIdFromDetailPath(currentPathname);
    const watchesCreation = autoOpensCreation || currentBoardId !== null;
    if (!watchesCreation) return;

    const controller = new AbortController();
    let baselineBoardIds: Set<string> | null = null;
    let inFlight = false;
    let navigationPending = false;

    const tick = async () => {
      if (document.visibilityState !== 'visible' || inFlight || navigationPending) return;
      inFlight = true;
      try {
        if (watchesCreation) {
          const result = await api.listBoards(null, controller.signal);
          if (controller.signal.aborted || result.kind !== 'ok') return;
          const nextBaseline = new Set<string>(
            result.value.boards.map((board: BoardSummaryV1) => board.boardId),
          );
          if (baselineBoardIds === null) {
            baselineBoardIds = nextBaseline;
            return;
          }
          const createdBoard = selectNewBoard<BoardSummaryV1>(
            baselineBoardIds,
            result.value.boards,
          );
          baselineBoardIds = nextBaseline;
          if (createdBoard !== null) {
            if (autoOpensCreation) {
              navigationPending = true;
              router.replace(`/boards/${encodeURIComponent(createdBoard.boardId)}`);
              return;
            }
            setPendingBoard(createdBoard);
          }
        }

        if (currentBoardId === null) return;
        const result = await api.getBoard(currentBoardId, controller.signal);
        if (controller.signal.aborted || !shouldLeaveCurrentBoard(result)) return;
        navigationPending = true;
        router.replace('/boards');
      } catch {
        return;
      } finally {
        inFlight = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    const interval = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void tick();

    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [api, pathname, router]);

  return (
    <ConfirmationDialog
      isOpen={pendingBoard !== null}
      title={t('board.newBoardDetectedTitle')}
      description={t('board.newBoardDetectedDescription', { title: pendingBoard?.title ?? '' })}
      confirmLabel={t('board.switchToNewBoard')}
      cancelLabel={t('board.keepCurrentBoard')}
      busy={false}
      error={null}
      confirmTone="primary"
      onConfirm={() => {
        if (pendingBoard === null) return;
        const boardId = pendingBoard.boardId;
        setPendingBoard(null);
        router.replace(`/boards/${encodeURIComponent(boardId)}`);
      }}
      onDismiss={() => setPendingBoard(null)}
    />
  );
}
