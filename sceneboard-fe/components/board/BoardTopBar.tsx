'use client';

import type { ReactNode } from 'react';

export function BoardTopBar({
  boardIdentity,
  mediaAuthoring,
  pageNavigation,
  revision,
  connections,
}: {
  boardIdentity: ReactNode;
  mediaAuthoring: ReactNode;
  pageNavigation: ReactNode;
  revision: ReactNode;
  connections: ReactNode;
}) {
  return (
    <header className="board-topbar">
      <div className="board-topbar-leading">
        <div className="board-topbar-identity">{boardIdentity}</div>
        <div className="board-topbar-media-authoring">{mediaAuthoring}</div>
      </div>
      <div className="board-topbar-page-navigation">{pageNavigation}</div>
      <div className="board-topbar-actions">
        <div className="board-topbar-revision">{revision}</div>
        <div className="board-topbar-connections">{connections}</div>
      </div>
    </header>
  );
}
