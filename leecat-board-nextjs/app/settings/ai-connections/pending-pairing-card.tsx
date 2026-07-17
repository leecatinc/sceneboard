'use client';

import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BoardSummaryV1, ClientGrantCapabilityV1 } from '@leecat-board/board-schema';
import type { PairingOwnerStatus } from '../../../lib/api/board-api';
import { useI18n } from '../../../components/i18n/I18nProvider';
import styles from './pairing-request.module.css';

export function PendingPairingModal({
  pairing,
  matchingCode,
  boards,
  busy,
  onDismiss,
  onCreateBoard,
  onApprove,
  onDeny,
  onCancel,
}: {
  pairing: PairingOwnerStatus;
  matchingCode: string | null;
  boards: BoardSummaryV1[];
  busy: boolean;
  onDismiss: () => void;
  onCreateBoard: () => Promise<BoardSummaryV1 | null>;
  onApprove: (decision: {
    approvedScopes: ClientGrantCapabilityV1[];
    approvedLifecyclePermissions: Array<'board.create' | 'board.archive'>;
    boardIds: string[];
    lifetime: 'session' | 'persistent';
  }) => void;
  onDeny: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const formId = useId();
  const [validation, setValidation] = useState<string | null>(null);
  const [selectedBoardIds, setSelectedBoardIds] = useState<string[]>([]);
  const [boardSearch, setBoardSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingBoard, setCreatingBoard] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    setValidation(null);
    setBoardSearch('');
    setPickerOpen(false);
    setSelectedBoardIds(pairing.boardIds ?? (boards.length === 1 ? [boards[0]!.boardId] : []));
  }, [pairing.pairingId]);

  const filteredBoards = useMemo(() => {
    const query = boardSearch.trim().toLocaleLowerCase();
    return query === '' ? boards : boards.filter((board) => board.title.toLocaleLowerCase().includes(query));
  }, [boardSearch, boards]);

  const selectedLabel = selectedBoardIds.length === 0
    ? t('ai.selectBoards')
    : t('ai.selectedBoardCount', { count: selectedBoardIds.length });

  function toggleBoard(boardId: string) {
    setSelectedBoardIds((current) => current.includes(boardId)
      ? current.filter((candidate) => candidate !== boardId)
      : [...current, boardId].sort());
  }

  async function createBoard() {
    setCreatingBoard(true);
    setValidation(null);
    const board = await onCreateBoard();
    setCreatingBoard(false);
    if (board === null) {
      setValidation(t('ai.boardCreateFailed'));
      return;
    }
    setSelectedBoardIds((current) => [...new Set([...current, board.boardId])].sort());
  }

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const approvedScopes = pairing.requestedScopes.filter((scope) => data.getAll('scope').includes(scope));
    const approvedLifecyclePermissions = pairing.requestedLifecyclePermissions.filter((permission) => data.getAll('lifecycle').includes(permission));
    const boardIds = [...selectedBoardIds].sort();
    const lifetime = data.get('lifetime') === 'persistent' ? 'persistent' : 'session';
    if (matchingCode === null) {
      setValidation(t('ai.approvalDisabled'));
      return;
    }
    if (approvedScopes.length === 0 || boardIds.length === 0) {
      setValidation(t('ai.selectScopeBoard'));
      return;
    }
    setValidation(null);
    onApprove({ approvedScopes, approvedLifecyclePermissions, boardIds, lifetime });
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <section className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{pairing.client?.clientName ?? t('ai.requestDetails')}</h2>
            <p id={descriptionId}>{t('ai.requestDetailsDescription')}</p>
          </div>
          <button type="button" className={styles.close} aria-label={t('common.dismiss')} onClick={onDismiss}>×</button>
        </header>
        <div className={styles.content}>
          <div className={styles.requestMeta}>
            <span>{t('ai.state', { state: pairing.state.replace('_', ' ') })}</span>
            {pairing.client && <span>{t('ai.installation', { value: pairing.client.installationFingerprint })}</span>}
          </div>
          <div className="meta">
            {pairing.requestedScopes.map((scope) => <span className="pill" key={scope}>{scope}</span>)}
            {pairing.requestedLifecyclePermissions.map((permission) => <span className="pill" key={permission}>{permission}</span>)}
          </div>
          {pairing.state === 'pending' ? (
            <form id={formId} className={styles.form} onSubmit={approve}>
              {matchingCode !== null ? <div><span className="muted">{t('ai.matchingCode')}</span><div className="code code-compact">{matchingCode}</div></div> : <p className="notice notice-error">{t('ai.approvalDisabled')}</p>}
              <fieldset><legend>{t('ai.approvedScopes')}</legend>{pairing.requestedScopes.map((scope) => <label key={scope}><input type="checkbox" name="scope" value={scope} defaultChecked /> {scope}</label>)}</fieldset>
              {pairing.requestedLifecyclePermissions.length > 0 && <fieldset><legend>{t('ai.lifecyclePermissions')}</legend>{pairing.requestedLifecyclePermissions.map((permission) => <label key={permission}><input type="checkbox" name="lifecycle" value={permission} defaultChecked /> {permission}</label>)}</fieldset>}
              <fieldset>
                <legend>{t('ai.boards')}</legend>
                <div className={styles.boardToolbar}>
                  <button type="button" className="button secondary" disabled={busy || creatingBoard} onClick={() => void createBoard()}>
                    {creatingBoard ? t('boards.creating') : `+ ${t('boards.new')}`}
                  </button>
                  <div className={styles.picker}>
                    <button type="button" className={styles.pickerButton} aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}>{selectedLabel}</button>
                    {pickerOpen && (
                      <div className={styles.pickerMenu}>
                        <input className={styles.search} value={boardSearch} onChange={(event) => setBoardSearch(event.target.value)} placeholder={t('ai.searchBoards')} aria-label={t('ai.searchBoards')} autoFocus />
                        <div className={styles.options} role="listbox" aria-multiselectable="true">
                          {filteredBoards.length === 0 ? <p className={styles.noMatches}>{t('ai.noMatchingBoards')}</p> : filteredBoards.map((board) => (
                            <label className={styles.option} role="option" aria-selected={selectedBoardIds.includes(board.boardId)} key={board.boardId}>
                              <input type="checkbox" checked={selectedBoardIds.includes(board.boardId)} onChange={() => toggleBoard(board.boardId)} />
                              {board.title}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </fieldset>
              <label className="field">{t('ai.lifetime')}<select name="lifetime" defaultValue="session"><option value="session">{t('ai.thisSession')}</option><option value="persistent">{t('ai.ninetyDays')}</option></select></label>
              {validation && <p className="error" role="alert">{validation}</p>}
            </form>
          ) : null}
        </div>
        <footer className={styles.actions}>
          {pairing.state === 'pending' && (
            <>
              <button type="submit" form={formId} className="button" disabled={busy || creatingBoard || matchingCode === null || selectedBoardIds.length === 0}>{t('ai.approve')}</button>
              <button type="button" className="button danger" disabled={busy || creatingBoard} onClick={onDeny}>{t('ai.deny')}</button>
            </>
          )}
          <button type="button" className="button danger" disabled={busy || creatingBoard} onClick={onCancel}>{t('ai.cancelCode')}</button>
        </footer>
      </section>
    </dialog>
  );
}
