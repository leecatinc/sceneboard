'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

import { ClipboardCopyButton } from '../../../components/ai-connections/ClipboardCopyButton';
import { useI18n } from '../../../components/i18n/I18nProvider';
import { authSessionClient } from '../../../lib/auth/session-client';
import { AccountApiKeyApi, type AccountApiKeyMetadata } from '../../../lib/api/account-api-key-api';
import { ApiKeyCreateSheet } from './api-key-create-sheet';
import styles from './api-key-management.module.css';

export function ApiKeyList() {
  const { t } = useI18n();
  const pathname = usePathname();
  const [items, setItems] = useState<AccountApiKeyMetadata[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const trigger = useRef<HTMLButtonElement>(null);
  const api = useRef<AccountApiKeyApi | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const clearSecret = useCallback(() => setSecret(null), []);
  const beginRequest = useCallback(() => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    return controller;
  }, []);
  const finish = useCallback((controller: AbortController) => {
    if (activeRequest.current !== controller) return false;
    activeRequest.current = null;
    return mounted.current && !controller.signal.aborted;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = beginRequest();
    api.current = new AccountApiKeyApi(authSessionClient().sharedCoordinator());
    void api.current.list(controller.signal).then((result) => {
      if (!finish(controller)) return;
      if (result.kind === 'ok') {
        setItems(result.value);
        setState('ready');
      } else {
        clearSecret();
        setState('error');
      }
    });
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = null;
      clearSecret();
    };
  }, [beginRequest, clearSecret, finish]);

  useEffect(() => clearSecret, [clearSecret, pathname]);

  useEffect(() => {
    if (secret === null) return;
    const timeout = window.setTimeout(clearSecret, 60_000);
    return () => window.clearTimeout(timeout);
  }, [clearSecret, secret]);

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
          clearSecret();
          const controller = beginRequest();
          setBusy(true);
          void api.current?.create(input, controller.signal).then((result) => {
            if (!finish(controller)) return;
            setBusy(false);
            if (result?.kind === 'ok') {
              setItems((current) => [result.value.metadata, ...current]);
              setSecret(result.value.apiKey);
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
          <p className={styles.error} role="alert">
            {t('apiKey.error')}
          </p>
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
                const controller = beginRequest();
                setBusy(true);
                void api.current?.revoke(item.apiKeyId, controller.signal).then((result) => {
                  if (!finish(controller)) return;
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
      </div>
      {secret !== null && (
        <div className={styles.backdrop} role="presentation">
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="api-key-secret-title"
          >
            <h2 id="api-key-secret-title">{t('apiKey.secretTitle')}</h2>
            <p>{t('apiKey.secretDescription')}</p>
            <code>{secret}</code>
            <ClipboardCopyButton
              value={secret}
              onCopied={() => {
                clearSecret();
                trigger.current?.focus();
              }}
            />
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                if (!window.confirm(t('apiKey.closeConfirm'))) return;
                clearSecret();
                trigger.current?.focus();
              }}
            >
              {t('apiKey.close')}
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
