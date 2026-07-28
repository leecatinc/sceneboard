'use client';

import type { ReactNode } from 'react';

export function BoardTopBar({
  boardIdentity,
  pageDisplay,
  mediaAuthoring,
  history,
  connections,
  ownerAdmin,
}: {
  boardIdentity: ReactNode;
  pageDisplay: ReactNode;
  mediaAuthoring: ReactNode;
  history: ReactNode;
  connections: ReactNode;
  ownerAdmin: ReactNode;
}) {
  return (
    <header className="board-topbar">
      <div className="board-topbar-identity">{boardIdentity}</div>
      <div className="board-topbar-page-display">{pageDisplay}</div>
      <div className="board-topbar-media-authoring">{mediaAuthoring}</div>
      <div className="board-topbar-connections">{connections}</div>
      <div className="board-topbar-history">{history}</div>
      <div className="board-topbar-owner-admin">{ownerAdmin}</div>
    </header>
  );
}
