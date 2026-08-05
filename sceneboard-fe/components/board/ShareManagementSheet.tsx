'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ShareManagementViewV1 } from '@sceneboard/board-schema';

import type { ShareAnalyticsApi } from '../../lib/share-analytics/share-analytics-api';
import {
  createShareIdempotencyKeyV1,
  type ShareApi,
  type SharePasswordResultV1,
  type SharePublishResultV1,
  type ShareRotateResultV1,
} from '../../lib/api/share-api';
import {
  beginShareSecretRequestV1,
  CLOSED_SHARE_SECRET_STATE_V1,
  settleShareSecretRequestV1,
  type ShareSecretActionV1,
  type ShareSecretRequestV1,
  type ShareSecretStateV1,
} from '../../lib/board/share-secret-state';
import { buildPublicShareUrlV1 } from '../../lib/board/share-link';
import { useI18n } from '../i18n/I18nProvider';
import { ConfirmationDialog } from '../app/ConfirmationDialog';
import { ShareAnalyticsPanel } from './ShareAnalyticsPanel';
import type { OwnerAdminCloseRegistration } from './OwnerAdminControls';
import { OwnerAdminActionIcon } from './OwnerAdminActionIcon';
import styles from './ShareManagementSheet.module.css';

type SecretResult = SharePublishResultV1 | ShareRotateResultV1 | SharePasswordResultV1;

export function ShareManagementSheet({
  api,
  analyticsApi,
  boardId,
  revisionId,
  enabled,
  analyticsEnabled,
  routeKey,
  forcedCloseEpoch,
  registerClose,
}: {
  api: ShareApi;
  analyticsApi: ShareAnalyticsApi;
  boardId: string;
  revisionId: string;
  enabled: boolean;
  analyticsEnabled: boolean;
  routeKey: string;
  forcedCloseEpoch: number;
  registerClose: OwnerAdminCloseRegistration;
}) {
  const { t, formatDateTime } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<ShareManagementViewV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [secret, setSecret] = useState<ShareSecretStateV1>(CLOSED_SHARE_SECRET_STATE_V1);
  const secretRef = useRef<ShareSecretStateV1>(CLOSED_SHARE_SECRET_STATE_V1);
  const currentRequestRef = useRef<ShareSecretRequestV1 | null>(null);
  const requestEpochRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);

  const invalidateSecret = useCallback(() => {
    requestEpochRef.current += 1;
    currentRequestRef.current = null;
    secretRef.current = { status: 'clearing' };
    setSecret({ status: 'clearing' });
    secretRef.current = CLOSED_SHARE_SECRET_STATE_V1;
    setSecret(CLOSED_SHARE_SECRET_STATE_V1);
  }, []);

  const close = useCallback(() => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    invalidateSecret();
    setConfirmRevoke(false);
    setOpen(false);
    setMessage('');
  }, [invalidateSecret]);

  const load = useCallback(async () => {
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    setLoading(true);
    const result = await api.list(boardId, controller.signal);
    if (controller.signal.aborted) return;
    requestAbortRef.current = null;
    setLoading(false);
    if (result.kind === 'ok') {
      setShare(result.value.shares.find((candidate) => candidate.status === 'active') ?? null);
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

  useEffect(() => registerClose(close), [close, registerClose]);

  useEffect(() => {
    close();
  }, [close, forcedCloseEpoch]);

  const runSecretLifecycle = useCallback(
    async (
      action: ShareSecretActionV1,
      operation: (signal: AbortSignal) => Promise<{ kind: string; value?: SecretResult }>,
      expectedShareId: string | null,
    ) => {
      requestAbortRef.current?.abort();
      const controller = new AbortController();
      requestAbortRef.current = controller;
      const begun = beginShareSecretRequestV1(requestEpochRef.current, action, expectedShareId);
      requestEpochRef.current = begun.request.requestEpoch;
      currentRequestRef.current = begun.request;
      secretRef.current = begun.state;
      setSecret(begun.state);
      setBusy(true);
      setMessage('');
      const result = await operation(controller.signal);
      if (controller.signal.aborted || result.kind !== 'ok' || result.value === undefined) {
        if (!controller.signal.aborted && currentRequestRef.current === begun.request) {
          currentRequestRef.current = null;
          secretRef.current = CLOSED_SHARE_SECRET_STATE_V1;
          setSecret(CLOSED_SHARE_SECRET_STATE_V1);
          setMessage(t('sharing.actionFailed'));
          setBusy(false);
        }
        return;
      }
      const settlement = settleShareSecretRequestV1(
        currentRequestRef.current,
        begun.request,
        result.value,
      );
      if (currentRequestRef.current !== begun.request) return;
      currentRequestRef.current = null;
      secretRef.current = settlement.state;
      setSecret(settlement.state);
      if (settlement.recovery !== null) {
        setMessage(
          t(
            settlement.recovery === 'rotate_required'
              ? 'sharing.rotateRequired'
              : 'sharing.regenerateRequired',
          ),
        );
      }
      await load();
      setBusy(false);
    },
    [load, t],
  );

  const mutateWithoutSecret = useCallback(
    async (operation: (signal: AbortSignal) => Promise<{ kind: string }>) => {
      requestAbortRef.current?.abort();
      const controller = new AbortController();
      requestAbortRef.current = controller;
      invalidateSecret();
      setBusy(true);
      setMessage('');
      const result = await operation(controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind !== 'ok') {
        setBusy(false);
        setMessage(t('sharing.actionFailed'));
        return;
      }
      await load();
      setBusy(false);
    },
    [invalidateSecret, load, t],
  );

  const persistentShareUrl =
    share === null
      ? null
      : buildPublicShareUrlV1(window.location.origin, share.shareId, share.accessGeneration);
  const visiblePassword =
    secret.status === 'showing' && secret.password !== null ? secret.password : null;

  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        className="button secondary board-owner-action-button"
        aria-label={t('sharing.manageShares')}
        title={t('sharing.manageShares')}
        onClick={() => setOpen(true)}
      >
        <OwnerAdminActionIcon kind="share" />
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className={styles.dialog}
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) close();
          }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !busy) close();
          }}
        >
          <section className={styles.panel}>
            <header className={styles.header}>
              <h2 id={titleId}>{t('sharing.manageShares')}</h2>
              <button type="button" className="button secondary" disabled={busy} onClick={close}>
                {t('sharing.close')}
              </button>
            </header>
            <div className={styles.content}>
              {loading ? (
                <p role="status">{t('common.loading')}</p>
              ) : share === null ? (
                <div className={styles.stack}>
                  <p>{t('sharing.noShare')}</p>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void runSecretLifecycle(
                        'share.create',
                        (signal) =>
                          api.publish(boardId, revisionId, createShareIdempotencyKeyV1(), signal),
                        null,
                      )
                    }
                  >
                    {t('sharing.publish')}
                  </button>
                </div>
              ) : (
                <div className={styles.stack}>
                  <p>
                    {t('sharing.shareStatus')}: {share.status} · {share.accessPolicy}
                  </p>
                  <p className={styles.muted}>
                    {t('sharing.updatedAt')}: {formatDateTime(share.updatedAt)}
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || share.pinnedRevisionId === revisionId}
                      onClick={() =>
                        void mutateWithoutSecret((signal) =>
                          api.update(
                            boardId,
                            share,
                            revisionId,
                            createShareIdempotencyKeyV1(),
                            signal,
                          ),
                        )
                      }
                    >
                      {t('sharing.updateRevision')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void runSecretLifecycle(
                          'share.rotate',
                          (signal) =>
                            api.rotate(boardId, share, createShareIdempotencyKeyV1(), signal),
                          share.shareId,
                        )
                      }
                    >
                      {t('sharing.rotateLink')}
                    </button>
                    {share.accessPolicy === 'L' ? (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void runSecretLifecycle(
                            'password.enable',
                            (signal) =>
                              api.enablePassword(
                                boardId,
                                share,
                                createShareIdempotencyKeyV1(),
                                signal,
                              ),
                            share.shareId,
                          )
                        }
                      >
                        {t('sharing.enablePassword')}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void runSecretLifecycle(
                              'password.regenerate',
                              (signal) =>
                                api.regeneratePassword(
                                  boardId,
                                  share,
                                  createShareIdempotencyKeyV1(),
                                  signal,
                                ),
                              share.shareId,
                            )
                          }
                        >
                          {t('sharing.regeneratePassword')}
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void mutateWithoutSecret((signal) =>
                              api.disablePassword(
                                boardId,
                                share,
                                createShareIdempotencyKeyV1(),
                                signal,
                              ),
                            )
                          }
                        >
                          {t('sharing.disablePassword')}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="button danger"
                      disabled={busy}
                      onClick={() => setConfirmRevoke(true)}
                    >
                      {t('sharing.revokeShare')}
                    </button>
                  </div>
                </div>
              )}
              {persistentShareUrl !== null && (
                <section className={styles.secret} aria-live="polite">
                  <h3>{t('sharing.shareLink')}</h3>
                  <p>{t('sharing.shareLinkAvailable')}</p>
                  <textarea
                    readOnly
                    value={persistentShareUrl}
                    aria-label={t('sharing.shareLink')}
                  />
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(persistentShareUrl)
                        .then(() => setMessage(t('sharing.copied')))
                        .catch(() => setMessage(t('sharing.copyFailed')));
                    }}
                  >
                    {t('sharing.copyLink')}
                  </button>
                </section>
              )}
              {visiblePassword !== null && (
                <section className={styles.secret} aria-live="polite">
                  <h3>{t('sharing.oneTimePassword')}</h3>
                  <p>{t('sharing.secretWarning')}</p>
                  <textarea
                    readOnly
                    value={visiblePassword}
                    aria-label={t('sharing.oneTimePassword')}
                  />
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(visiblePassword)
                        .then(() => setMessage(t('sharing.copied')))
                        .catch(() => setMessage(t('sharing.copyFailed')));
                    }}
                  >
                    {t('sharing.copyPassword')}
                  </button>
                </section>
              )}
              {message !== '' && (
                <p className={styles.notice} role="status" aria-live="polite">
                  {message}
                </p>
              )}
              <ShareAnalyticsPanel
                api={analyticsApi}
                boardId={boardId}
                enabled={analyticsEnabled}
              />
            </div>
          </section>
        </dialog>
      )}
      <ConfirmationDialog
        isOpen={confirmRevoke}
        title={t('sharing.revokeShare')}
        description={t('sharing.revokeShareConfirm')}
        confirmLabel={t('sharing.revokeShare')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        error={null}
        onDismiss={() => setConfirmRevoke(false)}
        onConfirm={() => {
          if (share === null) return;
          setConfirmRevoke(false);
          void mutateWithoutSecret((signal) =>
            api.revoke(boardId, share, createShareIdempotencyKeyV1(), signal),
          );
        }}
      />
    </>
  );
}
