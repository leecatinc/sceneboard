'use client';

import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

import type { BoardApiClient } from '../../lib/api/board-api';
import type { InvitationApi } from '../../lib/api/invitation-api';
import type { ShareApi } from '../../lib/api/share-api';
import type { ShareAnalyticsApi } from '../../lib/share-analytics/share-analytics-api';
import styles from '../../app/boards/[boardId]/board.module.css';
import { BoardArchiveControl } from './BoardArchiveControl';
import { MemberManagementSheet } from './MemberManagementSheet';
import { ShareManagementSheet } from './ShareManagementSheet';

export type OwnerAdminControlsHandle = {
  closeAndClearOwnerAdmin(): void;
};

export type OwnerAdminCloseRegistration = (close: () => void) => () => void;

export const OwnerAdminControls = forwardRef<
  OwnerAdminControlsHandle,
  {
    api: BoardApiClient;
    invitationApi: InvitationApi;
    shareApi: ShareApi;
    analyticsApi: ShareAnalyticsApi;
    boardId: string;
    boardTitle: string;
    revisionId: string;
    analyticsEnabled: boolean;
    routeKey: string;
    onArchived: () => void;
  }
>(function OwnerAdminControls(
  {
    api,
    invitationApi,
    shareApi,
    analyticsApi,
    boardId,
    boardTitle,
    revisionId,
    analyticsEnabled,
    routeKey,
    onArchived,
  },
  ref,
) {
  const [forcedCloseEpoch, setForcedCloseEpoch] = useState(0);
  const closeHandlers = useRef(new Set<() => void>());
  const registerClose = useCallback<OwnerAdminCloseRegistration>((close) => {
    closeHandlers.current.add(close);
    return () => {
      closeHandlers.current.delete(close);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      closeAndClearOwnerAdmin() {
        for (const close of closeHandlers.current) close();
        setForcedCloseEpoch((current) => current + 1);
      },
    }),
    [],
  );

  return (
    <div className={styles.ownerAdmin}>
      <ShareManagementSheet
        api={shareApi}
        analyticsApi={analyticsApi}
        boardId={boardId}
        revisionId={revisionId}
        enabled
        analyticsEnabled={analyticsEnabled}
        routeKey={routeKey}
        forcedCloseEpoch={forcedCloseEpoch}
        registerClose={registerClose}
      />
      <MemberManagementSheet
        api={invitationApi}
        boardId={boardId}
        enabled
        routeKey={routeKey}
        forcedCloseEpoch={forcedCloseEpoch}
        registerClose={registerClose}
      />
      <BoardArchiveControl
        api={api}
        boardId={boardId}
        boardTitle={boardTitle}
        onArchived={onArchived}
        forcedCloseEpoch={forcedCloseEpoch}
      />
    </div>
  );
});
