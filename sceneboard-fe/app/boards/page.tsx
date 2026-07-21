import { AppShell } from '../../components/app/AppShell';
import { AuthenticatedRoute } from '../../components/app/AuthenticatedRoute';
import { BoardsClient } from './boards-client';

export default function BoardsPage() {
  return (
    <AuthenticatedRoute>
      <AppShell titleKey="nav.boards">
        <BoardsClient />
      </AppShell>
    </AuthenticatedRoute>
  );
}
