'use client';

import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BoardSessionAccessV1, ClientGrantCapabilityV1 } from '@sceneboard/board-schema';

import type {
  CreatedPairing,
  PairingBoardDestination,
  PairingOwnerStatus,
} from '../../lib/api/board-api';
import { useI18n } from '../i18n/I18nProvider';
import { ClipboardCopyButton } from './ClipboardCopyButton';
import styles from './pairing-request.module.css';

interface PairingBoardOption {
  boardId: string;
  title: string;
}
type PairingRequest = CreatedPairing | PairingOwnerStatus;

const DEFAULT_CONNECTION_GRANT_CEILING: BoardSessionAccessV1['connectionGrantCeiling'] = {
  scopes: [
    'artifact.control',
    'artifact.publish',
    'board.history.read',
    'board.hitl.request',
    'board.hitl.respond',
    'board.media.write',
    'board.read',
    'board.write',
  ],
  lifecyclePermissions: ['board.archive', 'board.create'],
};

const isOwnerStatus = (pairing: PairingRequest): pairing is PairingOwnerStatus =>
  'requestedScopes' in pairing;

export function PairingRequestModal({
  pairing,
  matchingCode,
  boards,
  preferredBoardId = null,
  busy,
  error = null,
  connectionGrantCeiling = DEFAULT_CONNECTION_GRANT_CEILING,
  onDismiss,
  onApprove,
  onDeny,
  onCancel,
}: {
  pairing: PairingRequest;
  matchingCode: string | null;
  boards: PairingBoardOption[];
  preferredBoardId?: string | null;
  busy: boolean;
  error?: string | null;
  connectionGrantCeiling?: BoardSessionAccessV1['connectionGrantCeiling'];
  onDismiss: () => void;
  onApprove: (decision: {
    approvedScopes: ClientGrantCapabilityV1[];
    approvedLifecyclePermissions: Array<'board.create' | 'board.archive'>;
    destination: PairingBoardDestination;
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
  const [destinationMode, setDestinationMode] = useState<'create' | 'existing'>('existing');
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [boardSearch, setBoardSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const ownerStatus = isOwnerStatus(pairing) ? pairing : null;
  const allowedScopes =
    ownerStatus?.requestedScopes.filter((scope) => connectionGrantCeiling.scopes.includes(scope)) ??
    [];
  const allowedLifecyclePermissions =
    ownerStatus?.requestedLifecyclePermissions.filter((permission) =>
      connectionGrantCeiling.lifecyclePermissions.includes(permission),
    ) ?? [];
  const availablePreferredBoardId =
    preferredBoardId !== null && boards.some((board) => board.boardId === preferredBoardId)
      ? preferredBoardId
      : null;

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
    setDestinationMode('existing');
    setNewBoardTitle(t('boards.new'));
    setSelectedBoardId(availablePreferredBoardId);
  }, [availablePreferredBoardId, pairing.pairingId, t]);

  const filteredBoards = useMemo(() => {
    const query = boardSearch.trim().toLocaleLowerCase();
    return query === ''
      ? boards
      : boards.filter((board) => board.title.toLocaleLowerCase().includes(query));
  }, [boardSearch, boards]);

  const selectedBoard =
    selectedBoardId === null
      ? null
      : (boards.find((board) => board.boardId === selectedBoardId) ?? null);
  const selectedLabel = selectedBoard?.title ?? t('ai.selectBoards');

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ownerStatus === null) return;
    const data = new FormData(event.currentTarget);
    const approvedScopes = allowedScopes.filter((scope) => data.getAll('scope').includes(scope));
    const approvedLifecyclePermissions = allowedLifecyclePermissions.filter((permission) =>
      data.getAll('lifecycle').includes(permission),
    );
    const lifetime = data.get('lifetime') === 'persistent' ? 'persistent' : 'session';
    if (matchingCode === null) {
      setValidation(t('ai.approvalDisabled'));
      return;
    }
    const canCreateBoard =
      approvedScopes.includes('board.write') &&
      approvedLifecyclePermissions.includes('board.create');
    if (
      approvedScopes.length === 0 ||
      (destinationMode === 'create' && (!canCreateBoard || newBoardTitle.length === 0)) ||
      (destinationMode === 'existing' && selectedBoardId === null)
    ) {
      setValidation(t('ai.selectScopeBoard'));
      return;
    }
    const destination: PairingBoardDestination =
      destinationMode === 'create'
        ? { mode: 'create', title: newBoardTitle }
        : { mode: 'existing', boardId: selectedBoardId! };
    setValidation(null);
    onApprove({ approvedScopes, approvedLifecyclePermissions, destination, lifetime });
  }

  const isPending = ownerStatus?.state === 'pending';
  const title = isPending
    ? (ownerStatus.client?.clientName ?? t('ai.requestDetails'))
    : t('ai.waitingClient');
  const description = isPending ? t('ai.requestDetailsDescription') : t('ai.codeDescription');

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
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label={t('common.dismiss')}
            onClick={onDismiss}
          >
            ×
          </button>
        </header>
        <div className={styles.content}>
          <div className={styles.requestMeta}>
            <span>{t('ai.state', { state: pairing.state.replace('_', ' ') })}</span>
            {ownerStatus?.client && (
              <span>
                {t('ai.installation', { value: ownerStatus.client.installationFingerprint })}
              </span>
            )}
          </div>
          {matchingCode !== null && (
            <div>
              <span className="muted">
                {isPending ? t('ai.matchingCode') : t('ai.oneTimeCode')}
              </span>
              <div className="code code-compact">{matchingCode}</div>
              {!isPending && (
                <div className="actions">
                  <ClipboardCopyButton value={matchingCode} className="button secondary" />
                </div>
              )}
            </div>
          )}
          {ownerStatus !== null && (
            <div className="meta">
              {allowedScopes.map((scope) => (
                <span className="pill" key={scope}>
                  {scope}
                </span>
              ))}
              {allowedLifecyclePermissions.map((permission) => (
                <span className="pill" key={permission}>
                  {permission}
                </span>
              ))}
            </div>
          )}
          {isPending && ownerStatus !== null ? (
            <form id={formId} className={styles.form} onSubmit={approve}>
              {matchingCode === null && (
                <p className="notice notice-error">{t('ai.approvalDisabled')}</p>
              )}
              <fieldset>
                <legend>{t('ai.approvedScopes')}</legend>
                {allowedScopes.map((scope) => (
                  <label key={scope}>
                    <input type="checkbox" name="scope" value={scope} defaultChecked /> {scope}
                  </label>
                ))}
              </fieldset>
              {allowedLifecyclePermissions.length > 0 && (
                <fieldset>
                  <legend>{t('ai.lifecyclePermissions')}</legend>
                  {allowedLifecyclePermissions.map((permission) => (
                    <label key={permission}>
                      <input type="checkbox" name="lifecycle" value={permission} defaultChecked />{' '}
                      {permission}
                    </label>
                  ))}
                </fieldset>
              )}
              <fieldset>
                <legend>{t('ai.boards')}</legend>
                <label className={styles.destinationChoice}>
                  <input
                    type="radio"
                    name="destination"
                    value="create"
                    checked={destinationMode === 'create'}
                    onChange={() => setDestinationMode('create')}
                  />
                  <span>{t('boards.new')}</span>
                </label>
                {destinationMode === 'create' && (
                  <input
                    className={styles.newBoardTitle}
                    value={newBoardTitle}
                    maxLength={200}
                    aria-label={t('boards.new')}
                    onChange={(event) => setNewBoardTitle(event.target.value)}
                  />
                )}
                <label className={styles.destinationChoice}>
                  <input
                    type="radio"
                    name="destination"
                    value="existing"
                    checked={destinationMode === 'existing'}
                    onChange={() => setDestinationMode('existing')}
                  />
                  <span>{t('ai.selectBoards')}</span>
                </label>
                <div className={styles.boardToolbar} aria-disabled={destinationMode !== 'existing'}>
                  <div className={styles.picker}>
                    <button
                      type="button"
                      className={styles.pickerButton}
                      disabled={destinationMode !== 'existing'}
                      aria-expanded={pickerOpen}
                      onClick={() => setPickerOpen((open) => !open)}
                    >
                      {selectedLabel}
                    </button>
                    {pickerOpen && (
                      <div className={styles.pickerMenu}>
                        <input
                          className={styles.search}
                          value={boardSearch}
                          onChange={(event) => setBoardSearch(event.target.value)}
                          placeholder={t('ai.searchBoards')}
                          aria-label={t('ai.searchBoards')}
                          autoFocus
                        />
                        <div className={styles.options} role="radiogroup">
                          {filteredBoards.length === 0 ? (
                            <p className={styles.noMatches}>{t('ai.noMatchingBoards')}</p>
                          ) : (
                            filteredBoards.map((board) => (
                              <label className={styles.option} key={board.boardId}>
                                <input
                                  type="radio"
                                  name="existingBoard"
                                  checked={selectedBoardId === board.boardId}
                                  onChange={() => {
                                    setSelectedBoardId(board.boardId);
                                    setPickerOpen(false);
                                  }}
                                />
                                {board.title}
                              </label>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </fieldset>
              <label className="field">
                {t('ai.lifetime')}
                <select name="lifetime" defaultValue="session">
                  <option value="session">{t('ai.thisSession')}</option>
                  <option value="persistent">{t('ai.ninetyDays')}</option>
                </select>
              </label>
              {validation && (
                <p className="error" role="alert">
                  {validation}
                </p>
              )}
            </form>
          ) : null}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className={styles.actions}>
          {isPending && (
            <>
              <button
                type="submit"
                form={formId}
                className="button"
                disabled={busy || matchingCode === null}
              >
                {t('ai.approve')}
              </button>
              <button type="button" className="button danger" disabled={busy} onClick={onDeny}>
                {t('ai.deny')}
              </button>
            </>
          )}
          <button type="button" className="button danger" disabled={busy} onClick={onCancel}>
            {t('ai.cancelCode')}
          </button>
        </footer>
      </section>
    </dialog>
  );
}
