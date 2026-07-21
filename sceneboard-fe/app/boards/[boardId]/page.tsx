import { AppShell } from '../../../components/app/AppShell';
import { AuthenticatedRoute } from '../../../components/app/AuthenticatedRoute';
import { BoardClient } from './board-client';

export default async function BoardPage({ params }: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await params;
  return (
    <AuthenticatedRoute>
      <AppShell titleKey="board.liveBoard" viewportLocked>
        <BoardClient boardId={boardId} />
      </AppShell>
    </AuthenticatedRoute>
  );
}
