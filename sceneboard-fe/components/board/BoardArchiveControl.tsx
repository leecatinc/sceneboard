'use client';

import { useRef, useState } from 'react';

import { createBoardRequestIdentity, type BoardApiClient } from '../../lib/api/board-api';
import { useI18n } from '../i18n/I18nProvider';
import { ConfirmationDialog } from '../app/ConfirmationDialog';

export function BoardArchiveControl({
  api,
  boardId,
  boardTitle,
  onArchived,
}: {
  api: BoardApiClient;
  boardId: string;
  boardTitle: string;
  onArchived: () => void;
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdentity = useRef<ReturnType<typeof createBoardRequestIdentity> | null>(null);

  async function archive() {
    setBusy(true);
    setError(null);
    requestIdentity.current ??= createBoardRequestIdentity();
    const result = await api.archiveBoard({ boardId, ...requestIdentity.current });
    if (result.kind === 'ok') {
      requestIdentity.current = null;
      onArchived();
      return;
    }
    setError(t('board.deleteFailed'));
    setBusy(false);
  }

  return (
    <>
      <button
        type="button"
        className="button danger board-delete-button"
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
      >
        {t('board.delete')}
      </button>
      <ConfirmationDialog
        isOpen={isOpen}
        title={t('board.deleteDialogTitle')}
        description={t('board.deleteDialogDescription', { title: boardTitle })}
        confirmLabel={busy ? t('board.deleting') : t('board.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        error={error}
        onConfirm={() => void archive()}
        onDismiss={() => {
          setIsOpen(false);
          setError(null);
        }}
      />
    </>
  );
}
