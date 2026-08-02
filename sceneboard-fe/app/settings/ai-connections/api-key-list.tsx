'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

import { ClipboardCopyButton } from '../../../components/ai-connections/ClipboardCopyButton';
import { useI18n } from '../../../components/i18n/I18nProvider';
import { authSessionClient } from '../../../lib/auth/session-client';
import {
  AccountApiKeyApi,
  AccountApiKeyRequestOwnership,
  AccountApiKeyStaleRecovery,
  type AccountApiKeyMetadata,
} from '../../../lib/api/account-api-key-api';
import type { CurrentGenerationBindingV1 } from '../../../lib/auth/renewal-singleflight';
import { ApiKeyCreateSheet } from './api-key-create-sheet';
import styles from './api-key-management.module.css';

type DisplayedSecret = {
  value: string;
  generationBinding: CurrentGenerationBindingV1;
};

const uniqueItems = (items: AccountApiKeyMetadata[]): AccountApiKeyMetadata[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.apiKeyId)) return false;
    seen.add(item.apiKeyId);
    return true;
  });
};

const appendUniqueItems = (
  current: AccountApiKeyMetadata[],
  next: AccountApiKeyMetadata[],
): AccountApiKeyMetadata[] => {
  const seen = new Set(current.map((item) => item.apiKeyId));
  return [
    ...current,
    ...next.filter((item) => {
      if (seen.has(item.apiKeyId)) return false;
      seen.add(item.apiKeyId);
      return true;
    }),
  ];
};

export function ApiKeyList() {
  const { t } = useI18n();
  const pathname = usePathname();
  const currentPath = pathname ?? '/settings/ai-connections';
  const [items, setItems] = useState<AccountApiKeyMetadata[]>([]);
  const [secret, setSecret] = useState<DisplayedSecret | null>(null);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [continuationState, setContinuationState] = useState<'idle' | 'loading' | 'error'>('idle');
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const api = useRef<AccountApiKeyApi | null>(null);
  const requestOwnership = useRef(new AccountApiKeyRequestOwnership());
  const staleRecovery = useRef(new AccountApiKeyStaleRecovery());
  const viewGenerationBinding = useRef<CurrentGenerationBindingV1 | null>(null);
  const generationUnsubscribe = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const viewEpoch = useRef(0);
  const clearSecret = useCallback(() => setSecret(null), []);
  const scrubView = useCallback(() => {
    requestOwnership.current.abortAll();
    generationUnsubscribe.current?.();
    generationUnsubscribe.current = null;
    viewGenerationBinding.current = null;
    setItems([]);
    setNextCursor(null);
    setSecret(null);
    setBusy(false);
    setContinuationState('idle');
    setCopyStatus(null);
    setState('loading');
  }, []);

  const recoverStaleSession = useCallback(() => {
    void staleRecovery.current.recover({
      scrub: scrubView,
      reconcile: () => authSessionClient().reconcile(),
      onSignedOut: () => {
        if (mounted.current) window.location.assign('/login');
      },
      onActive: () => {
        if (mounted.current) window.location.assign(currentPath);
      },
      onFailed: () => {
        if (mounted.current) setState('error');
      },
    });
  }, [currentPath, scrubView]);

  const loadPage = useCallback(
    (cursor: string | null, append: boolean) => {
      const client = api.current;
      const binding = viewGenerationBinding.current;
      if (client === null || binding === null) {
        setState('error');
        return;
      }
      const controller = requestOwnership.current.begin('list', () => {
        if (!mounted.current) return;
        if (append) setContinuationState('idle');
        else setState('error');
      });
      if (append) setContinuationState('loading');
      else {
        clearSecret();
        setItems([]);
        setNextCursor(null);
        setContinuationState('idle');
        setState('loading');
      }
      void (async () => {
        let result = await client.list(binding, cursor, controller.signal);
        if (
          result.kind === 'stale_attempt' &&
          requestOwnership.current.isCurrent('list', controller) &&
          mounted.current
        ) {
          recoverStaleSession();
          return;
        }
        if (result.kind === 'reconciliation_required') {
          const reconciled = await authSessionClient().reconcile();
          if (!requestOwnership.current.isCurrent('list', controller) || !mounted.current) return;
          if (reconciled.kind === 'ok' && reconciled.value === null) {
            scrubView();
            window.location.assign('/login');
            return;
          }
          if (reconciled.kind === 'ok')
            result = await client.list(binding, cursor, controller.signal);
        }
        if (
          result.kind === 'stale_attempt' &&
          requestOwnership.current.isCurrent('list', controller) &&
          mounted.current
        ) {
          recoverStaleSession();
          return;
        }
        if (!requestOwnership.current.finish('list', controller) || !mounted.current) return;
        if (result.kind === 'ok') {
          setItems((current) =>
            append
              ? appendUniqueItems(current, result.value.items)
              : uniqueItems(result.value.items),
          );
          setNextCursor(result.value.nextCursor);
          setContinuationState('idle');
          setState('ready');
        } else if (append) setContinuationState('error');
        else {
          clearSecret();
          setState('error');
        }
      })();
    },
    [clearSecret, recoverStaleSession, scrubView],
  );

  useEffect(() => {
    const epoch = viewEpoch.current + 1;
    viewEpoch.current = epoch;
    const isActive = () => mounted.current && viewEpoch.current === epoch;
    const ownership = requestOwnership.current;
    mounted.current = true;
    scrubView();
    const sessionClient = authSessionClient();
    const coordinator = sessionClient.sharedCoordinator();
    api.current = new AccountApiKeyApi(coordinator);
    void (async () => {
      let admitted = await coordinator.bindCurrentGeneration();
      if (!isActive()) return;
      if (admitted.kind !== 'bound') {
        const reconciled = await sessionClient.reconcile();
        if (!isActive()) return;
        if (reconciled.kind === 'ok' && reconciled.value === null) {
          scrubView();
          window.location.assign('/login');
          return;
        }
        if (reconciled.kind === 'ok') admitted = await coordinator.bindCurrentGeneration();
      }
      if (!isActive()) return;
      if (admitted.kind !== 'bound') {
        setState('error');
        return;
      }
      const binding = admitted.binding;
      viewGenerationBinding.current = binding;
      generationUnsubscribe.current = coordinator.subscribeGenerationInvalidation(binding, () => {
        if (viewGenerationBinding.current !== binding) return;
        recoverStaleSession();
      });
      if (viewGenerationBinding.current === binding) loadPage(null, false);
    })();
    return () => {
      if (viewEpoch.current !== epoch) return;
      viewEpoch.current += 1;
      mounted.current = false;
      ownership.abortAll();
      generationUnsubscribe.current?.();
      generationUnsubscribe.current = null;
      viewGenerationBinding.current = null;
      clearSecret();
    };
  }, [clearSecret, currentPath, loadPage, recoverStaleSession, scrubView]);

  useEffect(() => clearSecret, [clearSecret, pathname]);

  useEffect(() => {
    if (secret === null) return;
    const deadline = Date.now() + 60_000;
    const expire = () => {
      if (Date.now() >= deadline) clearSecret();
    };
    const timeout = window.setTimeout(expire, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') expire();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [clearSecret, secret]);

  useEffect(() => {
    if (secret === null) return;
    const currentDialog = dialog.current;
    if (currentDialog === null) return;
    const focusTarget = trigger.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    currentDialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (currentDialog.open) currentDialog.close();
      focusTarget?.focus();
    };
  }, [secret]);

  useEffect(() => {
    if (copyStatus === null) return;
    const timeout = window.setTimeout(() => setCopyStatus(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  return (
    <section className={`section ${styles.section}`} aria-labelledby="api-key-title">
      <div className="section-head">
        <div>
          <h2 id="api-key-title">{t('apiKey.title')}</h2>
          <p className="muted">{t('apiKey.description')}</p>
        </div>
      </div>
      <ApiKeyCreateSheet
        busy={busy || state === 'loading'}
        triggerRef={trigger}
        onCreate={(input) => {
          const client = api.current;
          const binding = viewGenerationBinding.current;
          if (client === null || binding === null) return;
          clearSecret();
          const controller = requestOwnership.current.begin('mutation', () => {
            if (mounted.current) setBusy(false);
          });
          setBusy(true);
          void client.create(input, controller.signal).then((result) => {
            if (!requestOwnership.current.isCurrent('mutation', controller) || !mounted.current)
              return;
            if (result.kind === 'stale_attempt') {
              recoverStaleSession();
              return;
            }
            if (!requestOwnership.current.finish('mutation', controller)) return;
            setBusy(false);
            if (
              result.kind === 'ok' &&
              viewGenerationBinding.current?.sessionGeneration ===
                result.value.generationBinding.sessionGeneration
            ) {
              setItems((current) => uniqueItems([result.value.metadata, ...current]));
              setSecret({
                value: result.value.apiKey,
                generationBinding: result.value.generationBinding,
              });
              setState('ready');
            } else {
              clearSecret();
              setState('error');
            }
          });
        }}
      />
      <div className={styles.list} aria-live="polite" aria-busy={state === 'loading'}>
        {state === 'loading' && <p className="muted">{t('apiKey.loading')}</p>}
        {state === 'error' && (
          <div className={styles.error} role="alert">
            <p>{t('apiKey.error')}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                if (viewGenerationBinding.current === null) window.location.assign(currentPath);
                else loadPage(null, false);
              }}
            >
              {t('apiKey.retry')}
            </button>
          </div>
        )}
        {state === 'ready' && items.length === 0 && <p className="muted">{t('apiKey.empty')}</p>}
        {items.map((item) => (
          <article className="item" key={item.apiKeyId}>
            <strong>{item.name}</strong>
            <span className="muted">
              {item.prefix} · {t(`apiKey.status.${item.status}`)}
            </span>
            <button
              type="button"
              className="button secondary"
              disabled={busy || item.status === 'revoked'}
              onClick={() => {
                if (!window.confirm(t('apiKey.revokeConfirm'))) return;
                const client = api.current;
                const binding = viewGenerationBinding.current;
                if (client === null || binding === null) return;
                const controller = requestOwnership.current.begin('mutation', () => {
                  if (mounted.current) setBusy(false);
                });
                setBusy(true);
                void client.revoke(binding, item.apiKeyId, controller.signal).then((result) => {
                  if (
                    !requestOwnership.current.isCurrent('mutation', controller) ||
                    !mounted.current
                  )
                    return;
                  if (result.kind === 'stale_attempt') {
                    recoverStaleSession();
                    return;
                  }
                  if (!requestOwnership.current.finish('mutation', controller)) return;
                  setBusy(false);
                  if (result?.kind === 'ok')
                    setItems((current) =>
                      current.map((value) =>
                        value.apiKeyId === item.apiKeyId ? { ...value, status: 'revoked' } : value,
                      ),
                    );
                  else {
                    clearSecret();
                    setState('error');
                  }
                });
              }}
            >
              {t('apiKey.revoke')}
            </button>
          </article>
        ))}
        {state === 'ready' && nextCursor !== null && (
          <button
            type="button"
            className="button secondary"
            disabled={busy || continuationState === 'loading'}
            aria-busy={continuationState === 'loading'}
            onClick={() => loadPage(nextCursor, true)}
          >
            {continuationState === 'loading' ? t('apiKey.loadingMore') : t('apiKey.loadMore')}
          </button>
        )}
        {continuationState === 'error' && nextCursor !== null && (
          <div className={styles.error} role="alert">
            <p>{t('apiKey.error')}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => loadPage(nextCursor, true)}
            >
              {t('apiKey.retry')}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => loadPage(null, false)}
            >
              {t('apiKey.refresh')}
            </button>
          </div>
        )}
      </div>
      {secret !== null && (
        <dialog
          ref={dialog}
          className={styles.dialog}
          aria-labelledby="api-key-secret-title"
          onCancel={(event) => {
            event.preventDefault();
            if (window.confirm(t('apiKey.closeConfirm'))) clearSecret();
          }}
        >
          <section>
            <h2 id="api-key-secret-title">{t('apiKey.secretTitle')}</h2>
            <p>{t('apiKey.secretDescription')}</p>
            <code>{secret.value}</code>
            <ClipboardCopyButton
              value={secret.value}
              autoFocus
              onCopied={() => {
                setCopyStatus('copied');
                clearSecret();
              }}
              onCopyFailed={() => setCopyStatus('failed')}
            />
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                if (!window.confirm(t('apiKey.closeConfirm'))) return;
                clearSecret();
              }}
            >
              {t('apiKey.close')}
            </button>
          </section>
        </dialog>
      )}
      <p className={styles.copyStatus} role="status" aria-live="polite">
        {copyStatus === 'copied'
          ? t('ai.copiedToClipboard')
          : copyStatus === 'failed'
            ? t('apiKey.copyFailed')
            : ''}
      </p>
    </section>
  );
}
