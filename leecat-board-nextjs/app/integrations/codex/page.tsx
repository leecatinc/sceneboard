import type { Metadata } from 'next';

import { CodexInstallClient } from './codex-install-client';

export const metadata: Metadata = {
  title: 'Install SceneBoard for Codex',
  description: 'Install the SceneBoard Codex plugin and connect it to your live boards.',
};

export default function CodexIntegrationPage() {
  return <CodexInstallClient />;
}
