import type { Metadata } from 'next';

import { bootstrapSharedBoard, submitSharedBoardPassword } from './shared-board-actions';
import { SharedBoardClient } from './shared-board-client';

export const metadata: Metadata = {
  title: 'Shared SceneBoard',
  robots: { index: false, follow: false, nocache: true },
};

export default async function SharedBoardPage({
  params,
}: {
  params: Promise<{ shareToken: string }>;
}) {
  const { shareToken } = await params;
  const initialState = await bootstrapSharedBoard(shareToken);
  const bootstrapAction = bootstrapSharedBoard.bind(null, shareToken);
  const passwordAction = submitSharedBoardPassword.bind(null, shareToken);
  return (
    <SharedBoardClient
      initialState={initialState}
      bootstrapAction={bootstrapAction}
      passwordAction={passwordAction}
    />
  );
}
