'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  AccessManagementListV1,
  InvitationRoleV1,
  ManagedMemberSummaryV1,
  MemberCandidateV1,
  PendingInvitationSummaryV1,
} from '@sceneboard/board-schema';

import type { InvitationApi } from '../../lib/api/invitation-api';
import {
  preserveMemberCandidateOrderV1,
  type MemberCandidateRowV1,
} from '../../lib/board/member-management-state';
import { ConfirmationDialog } from '../app/ConfirmationDialog';
import { useI18n } from '../i18n/I18nProvider';
import styles from './MemberManagementSheet.module.css';

type Confirmation =
  | { kind: 'member'; member: ManagedMemberSummaryV1 }
  | { kind: 'invitation'; invitation: PendingInvitationSummaryV1 };

const EMPTY_ACCESS: AccessManagementListV1 = { members: [], invitations: [] };

export function MemberManagementSheet({
  api,
  boardId,
  enabled,
  routeKey,
}: {
  api: InvitationApi;
  boardId: string;
  enabled: boolean;
  routeKey: string;
}) {
  const { t, formatDateTime } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<AccessManagementListV1>(EMPTY_ACCESS);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<MemberCandidateRowV1[]>([]);
  const [role, setRole] = useState<InvitationRoleV1>('viewer');
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const requestEpochRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  const invalidate = useCallback(() => {
    requestEpochRef.current += 1;
    listAbortRef.current?.abort();
    searchAbortRef.current?.abort();
    listAbortRef.current = null;
    searchAbortRef.current = null;
  }, []);

  const close = useCallback(() => {
    invalidate();
    setOpen(false);
    setQuery('');
    setCandidates([]);
    setConfirmation(null);
    setMessage('');
  }, [invalidate]);

  const load = useCallback(async () => {
    const controller = new AbortController();
    listAbortRef.current?.abort();
    listAbortRef.current = controller;
    const epoch = ++requestEpochRef.current;
    setLoading(true);
    const result = await api.list(boardId, controller.signal);
    if (controller.signal.aborted || epoch !== requestEpochRef.current) return;
    listAbortRef.current = null;
    setLoading(false);
    if (result.kind === 'ok') {
      setAccess(result.value);
      return;
    }
    setMessage(t('sharing.loadFailed'));
  }, [api, boardId, t]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    void load();
    return () => {
      document.body.style.overflow = overflow;
      if (dialog.open) dialog.close();
    };
  }, [load, open]);

  useEffect(() => {
    if (!enabled && open) close();
  }, [close, enabled, open]);

  useEffect(() => close, [close, routeKey]);

  useEffect(() => {
    searchAbortRef.current?.abort();
    if (!open || [...query.trim()].length < 3) {
      setCandidates([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      const epoch = ++requestEpochRef.current;
      setSearching(true);
      void api.search(boardId, query.trim(), controller.signal).then((result) => {
        if (controller.signal.aborted || epoch !== requestEpochRef.current) return;
        setSearching(false);
        if (result.kind === 'ok') {
          setCandidates(preserveMemberCandidateOrderV1(result.value.candidates));
          return;
        }
        setCandidates([]);
        setMessage(t('sharing.actionFailed'));
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, boardId, open, query, t]);

  const runMutation = useCallback(
    async (key: string, operation: (signal: AbortSignal) => Promise<{ kind: string }>) => {
      const controller = new AbortController();
      listAbortRef.current?.abort();
      listAbortRef.current = controller;
      const epoch = ++requestEpochRef.current;
      setBusyKey(key);
      setMessage('');
      const result = await operation(controller.signal);
      if (controller.signal.aborted || epoch !== requestEpochRef.current) return;
      setBusyKey(null);
      if (result.kind !== 'ok') {
        setMessage(t('sharing.actionFailed'));
        return;
      }
      await load();
    },
    [load, t],
  );

  const issue = (candidate: MemberCandidateV1 & { key: string }) => {
    void runMutation(`candidate:${candidate.key}`, (signal) =>
      api.issue(
        boardId,
        candidate.kind === 'account'
          ? { accountId: candidate.accountId }
          : { email: candidate.email },
        role,
        signal,
      ),
    );
  };

  if (!enabled) return null;
  return (
    <>
      <button type="button" className="button secondary" onClick={() => setOpen(true)}>
        {t('sharing.manageMembers')}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className={styles.dialog}
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            if (busyKey === null) close();
          }}
        >
          <section className={styles.panel}>
            <header className={styles.header}>
              <h2 id={titleId}>{t('sharing.manageMembers')}</h2>
              <button
                type="button"
                className="button secondary"
                disabled={busyKey !== null}
                onClick={close}
              >
                {t('sharing.close')}
              </button>
            </header>
            <div className={styles.content}>
              <section className={styles.stack}>
                <h3>{t('sharing.inviteMember')}</h3>
                <label>
                  {t('sharing.searchMembers')}
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('sharing.searchHint')}
                  />
                </label>
                <label>
                  {t('sharing.role')}
                  <select
                    value={role}
                    onChange={(event) => setRole(event.target.value as InvitationRoleV1)}
                  >
                    <option value="viewer">{t('sharing.viewer')}</option>
                    <option value="editor">{t('sharing.editor')}</option>
                  </select>
                </label>
                {searching && <p role="status">{t('common.loading')}</p>}
                {!searching && query.trim().length >= 3 && candidates.length === 0 && (
                  <p>{t('sharing.noCandidates')}</p>
                )}
                <ul className={styles.list}>
                  {candidates.map((candidate) => (
                    <li key={`${candidate.kind}:${candidate.key}`}>
                      <span>
                        {candidate.kind === 'account' ? candidate.displayName : candidate.email}
                      </span>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busyKey !== null}
                        onClick={() => issue(candidate)}
                      >
                        {t('sharing.invite')}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className={styles.stack}>
                <h3>{t('sharing.activeMembers')}</h3>
                {loading ? (
                  <p role="status">{t('common.loading')}</p>
                ) : access.members.length === 0 ? (
                  <p>{t('sharing.noMembers')}</p>
                ) : (
                  <ul className={styles.list}>
                    {access.members.map((member) => (
                      <li key={member.memberId}>
                        <span className={styles.identity}>{member.accountId}</span>
                        <select
                          aria-label={t('sharing.role')}
                          value={member.role}
                          disabled={busyKey !== null}
                          onChange={(event) =>
                            void runMutation(`member:${member.memberId}`, (signal) =>
                              api.updateMember(
                                boardId,
                                member.memberId,
                                event.target.value as InvitationRoleV1,
                                member.version,
                                signal,
                              ),
                            )
                          }
                        >
                          <option value="viewer">{t('sharing.viewer')}</option>
                          <option value="editor">{t('sharing.editor')}</option>
                        </select>
                        <button
                          type="button"
                          className="button danger"
                          disabled={busyKey !== null}
                          onClick={() => setConfirmation({ kind: 'member', member })}
                        >
                          {t('sharing.remove')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className={styles.stack}>
                <h3>{t('sharing.pendingInvitations')}</h3>
                {access.invitations.length === 0 ? (
                  <p>{t('sharing.noInvitations')}</p>
                ) : (
                  <ul className={styles.list}>
                    {access.invitations.map((invitation) => (
                      <li key={invitation.inviteId}>
                        <span>
                          {invitation.role} · {formatDateTime(invitation.expiresAt)}
                        </span>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runMutation(`invite:${invitation.inviteId}`, (signal) =>
                              api.resend(boardId, invitation.inviteId, signal),
                            )
                          }
                        >
                          {t('sharing.resend')}
                        </button>
                        <button
                          type="button"
                          className="button danger"
                          disabled={busyKey !== null}
                          onClick={() => setConfirmation({ kind: 'invitation', invitation })}
                        >
                          {t('sharing.revokeInvitation')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {message !== '' && (
                <p role="status" aria-live="polite">
                  {message}
                </p>
              )}
            </div>
          </section>
        </dialog>
      )}
      <ConfirmationDialog
        isOpen={confirmation !== null}
        title={
          confirmation?.kind === 'member' ? t('sharing.remove') : t('sharing.revokeInvitation')
        }
        description={t('sharing.destructiveConfirm')}
        confirmLabel={
          confirmation?.kind === 'member' ? t('sharing.remove') : t('sharing.revokeInvitation')
        }
        cancelLabel={t('common.cancel')}
        busy={busyKey !== null}
        error={null}
        onDismiss={() => setConfirmation(null)}
        onConfirm={() => {
          const target = confirmation;
          if (target === null) return;
          setConfirmation(null);
          if (target.kind === 'member') {
            void runMutation(`member:${target.member.memberId}`, (signal) =>
              api.removeMember(boardId, target.member.memberId, target.member.version, signal),
            );
          } else {
            void runMutation(`invite:${target.invitation.inviteId}`, (signal) =>
              api.revoke(boardId, target.invitation.inviteId, signal),
            );
          }
        }}
      />
    </>
  );
}
