import { AppShell } from '../../../components/app/AppShell';
import { AuthenticatedRoute } from '../../../components/app/AuthenticatedRoute';
import { AiConnectionsClient } from './ai-connections-client';

export default function AiConnectionsPage() {
  return <AuthenticatedRoute><AppShell titleKey="ai.title"><AiConnectionsClient /></AppShell></AuthenticatedRoute>;
}
