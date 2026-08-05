'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import type { BoardApiClient } from '../../lib/api/board-api';
import type { BoardExportApi } from '../../lib/api/board-export-api';
import type { PresentationFormatV1 } from '@sceneboard/board-schema';
import type { InvitationApi } from '../../lib/api/invitation-api';
import type { ShareApi } from '../../lib/api/share-api';
import type { ShareAnalyticsApi } from '../../lib/share-analytics/share-analytics-api';
import styles from '../../app/boards/[boardId]/board.module.css';
import { useI18n } from '../i18n/I18nProvider';
import { BoardArchiveControl } from './BoardArchiveControl';
import { BoardExportControl } from './BoardExportControl';
import { MemberManagementSheet } from './MemberManagementSheet';
import { OwnerAdminActionIcon } from './OwnerAdminActionIcon';
import { ShareManagementSheet } from './ShareManagementSheet';
import sheetStyles from './ShareManagementSheet.module.css';

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
    canEditDocumentFormat: boolean;
    onDocumentFormatChange: (format: PresentationFormatV1) => Promise<boolean>;
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
    canEditDocumentFormat,
    onDocumentFormatChange,
    exportEnabled,
    analyticsEnabled,
    routeKey,
    onArchived,
  },
  ref,
) {
  const { t } = useI18n();
  const settingsId = useId();
  const settingsTitleId = useId();
  const [forcedCloseEpoch, setForcedCloseEpoch] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
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
        setSettingsOpen(false);
        setForcedCloseEpoch((current) => current + 1);
      },
    }),
    [],
  );

  useEffect(() => {
    setSettingsOpen(false);
  }, [routeKey]);

  useEffect(() => {
    if (!settingsOpen) return;
    const dialog = settingsDialogRef.current;
    if (dialog === null) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      document.body.style.overflow = overflow;
      if (dialog.open) dialog.close();
    };
  }, [settingsOpen]);

  return (
    <div className={styles.ownerAdmin} data-owner-admin-controls>
      <BoardExportControl
        api={exportApi}
        boardId={boardId}
        boardTitle={boardTitle}
        revisionId={revisionId}
        revisionNumber={revisionNumber}
        documentFormat={documentFormat}
        canEditDocumentFormat={canEditDocumentFormat}
        onDocumentFormatChange={onDocumentFormatChange}
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
      <div className={styles.ownerSettings}>
        <button
          type="button"
          className="button secondary board-owner-action-button"
          aria-label={t('presentation.boardControls')}
          title={t('presentation.boardControls')}
          aria-expanded={settingsOpen}
          aria-controls={settingsId}
          onClick={() => setSettingsOpen((current) => !current)}
        >
          <OwnerAdminActionIcon kind="settings" />
        </button>
        {settingsOpen && (
          <dialog
            ref={settingsDialogRef}
            id={settingsId}
            className={sheetStyles.dialog}
            aria-labelledby={settingsTitleId}
            onCancel={(event) => {
              event.preventDefault();
              setSettingsOpen(false);
            }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSettingsOpen(false);
            }}
          >
            <section className={sheetStyles.panel}>
              <header className={sheetStyles.header}>
                <h2 id={settingsTitleId}>{t('presentation.boardControls')}</h2>
                <button
                  type="button"
                  className="button secondary"
                  aria-label={t('presentation.closeBoardControls')}
                  onClick={() => setSettingsOpen(false)}
                >
                  {t('sharing.close')}
                </button>
              </header>
              <div className={sheetStyles.content}>
                <div className={styles.ownerSettingsDanger}>
                  <BoardArchiveControl
                    api={api}
                    boardId={boardId}
                    boardTitle={boardTitle}
                    onArchived={onArchived}
                    forcedCloseEpoch={forcedCloseEpoch}
                  />
                </div>
              </div>
            </section>
          </dialog>
        )}
      </div>
    </div>
  );
});
