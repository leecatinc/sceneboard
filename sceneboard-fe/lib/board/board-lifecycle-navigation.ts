import type { ApiResult, BoardGetResult } from '../api/board-api';

export interface BoardLifecycleCandidate {
  boardId: string;
  createdAt: string;
}

const CREATION_AUTO_OPEN_PATHS = new Set(['/boards', '/settings/ai-connections']);

export function isBoardCreationAutoOpenPath(pathname: string): boolean {
  return CREATION_AUTO_OPEN_PATHS.has(pathname);
}

export function boardIdFromDetailPath(pathname: string): string | null {
  const match = /^\/boards\/([^/]+)$/u.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export function selectNewBoard<T extends BoardLifecycleCandidate>(
  baselineBoardIds: ReadonlySet<string>,
  boards: readonly T[],
): T | null {
  const candidates = boards.filter(({ boardId }) => !baselineBoardIds.has(boardId));
  candidates.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.boardId.localeCompare(right.boardId),
  );
  return candidates[0] ?? null;
}

export function shouldLeaveCurrentBoard(result: ApiResult<BoardGetResult>): boolean {
  if (result.kind === 'ok') return result.value.board.archivedAt !== null;
  if (result.kind === 'board_error') return result.error.code === 'BOARD_NOT_FOUND';
  return result.kind === 'api_error' && result.status === 404;
}
