'use client';

import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

import type { BoardApiClient } from '../../lib/api/board-api';
import type { BoardExportApi } from '../../lib/api/board-export-api';
import type { PresentationFormatV1 } from '@sceneboard/board-schema';
import type { InvitationApi } from '../../lib/api/invitation-api';
import type { ShareApi } from '../../lib/api/share-api';
import type { ShareAnalyticsApi } from '../../lib/share-analytics/share-analytics-api';
import styles from '../../app/boards/[boardId]/board.module.css';
import { BoardArchiveControl } from './BoardArchiveControl';
import { BoardExportControl } from './BoardExportControl';
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
    exportApi: BoardExportApi;
    invitationApi: InvitationApi;
    shareApi: ShareApi;
    analyticsApi: ShareAnalyticsApi;
    boardId: string;
    boardTitle: string;
    revisionId: string;
    revisionNumber: number;
    documentFormat: PresentationFormatV1;
    exportEnabled: boolean;
    analyticsEnabled: boolean;
    routeKey: string;
    onArchived: () => void;
  }
>(function OwnerAdminControls(
  {
    api,
    exportApi,
    invitationApi,
    shareApi,
    analyticsApi,
    boardId,
    boardTitle,
    revisionId,
    revisionNumber,
    documentFormat,
    exportEnabled,
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
      <BoardExportControl
        api={exportApi}
        boardId={boardId}
        boardTitle={boardTitle}
        revisionId={revisionId}
        revisionNumber={revisionNumber}
        documentFormat={documentFormat}
        enabled={exportEnabled}
        routeKey={routeKey}
        forcedCloseEpoch={forcedCloseEpoch}
        registerClose={registerClose}
      />
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
