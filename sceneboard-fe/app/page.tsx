import type { Metadata } from 'next';

import { LandingPage } from '../components/landing/LandingPage';

export const metadata: Metadata = {
  title: 'SceneBoard — The whiteboard Codex can operate freely',
  description:
    'A visual workspace where Codex turns dense plans, references, and human decisions into clear, presentation-ready scenes.',
};

export default function RootPage() {
  return <LandingPage />;
}
