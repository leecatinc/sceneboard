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
import { buildApiKeyMcpJsonExample } from './api-key-mcp-example';
import styles from './api-key-management.module.css';
import groupStyles from './connection-method-group.module.css';

type DisplayedSecret = {
  value: string;
  generationBinding: CurrentGenerationBindingV1;
};

type SecretSetupTab = 'mcp' | 'environment';

const POSIX_ENV_EXAMPLE = `export SCENEBOARD_API_KEY='<발급받은 키>'`;
const POWERSHELL_ENV_EXAMPLE = `$env:SCENEBOARD_API_KEY='<발급받은 키>'`;

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
  const [guideItem, setGuideItem] = useState<AccountApiKeyMetadata | null>(null);
  const [copyStatus, setCopyStatus] = useState<'failed' | null>(null);
  const [secretSetupTab, setSecretSetupTab] = useState<SecretSetupTab>('mcp');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [continuationState, setContinuationState] = useState<'idle' | 'loading' | 'error'>('idle');
  const mcpJsonExample = buildApiKeyMcpJsonExample(secret?.value ?? null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogReturnFocus = useRef<HTMLButtonElement | null>(null);
  const api = useRef<AccountApiKeyApi | null>(null);
  const requestOwnership = useRef(new AccountApiKeyRequestOwnership());
  const staleRecovery = useRef(new AccountApiKeyStaleRecovery());
  const viewGenerationBinding = useRef<CurrentGenerationBindingV1 | null>(null);
  const generationUnsubscribe = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const viewEpoch = useRef(0);
  const clearSecret = useCallback(() => setSecret(null), []);
  const clearSetupModal = useCallback(() => {
    setSecret(null);
    setGuideItem(null);
    setCopyStatus(null);
  }, []);
  const scrubView = useCallback(() => {
    requestOwnership.current.abortAll();
    generationUnsubscribe.current?.();
    generationUnsubscribe.current = null;
    viewGenerationBinding.current = null;
    setItems([]);
    setNextCursor(null);
    setSecret(null);
    setGuideItem(null);
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
      clearSetupModal();
    };
  }, [clearSetupModal, currentPath, loadPage, recoverStaleSession, scrubView]);

  useEffect(() => clearSetupModal, [clearSetupModal, pathname]);

  useEffect(() => {
    if (secret === null && guideItem === null) return;
    const currentDialog = dialog.current;
    if (currentDialog === null) return;
    const focusTarget = dialogReturnFocus.current ?? trigger.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    currentDialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (currentDialog.open) currentDialog.close();
      focusTarget?.focus();
    };
  }, [guideItem, secret]);

  useEffect(() => {
    if (copyStatus === null) return;
    const timeout = window.setTimeout(() => setCopyStatus(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  return (
    <section
      className={`section ${groupStyles.group} ${styles.section}`}
      aria-labelledby="api-key-title"
    >
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
          clearSetupModal();
          dialogReturnFocus.current = trigger.current;
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
              setGuideItem(null);
              setSecretSetupTab('mcp');
              setState('ready');
            } else {
              clearSetupModal();
              setState('error');
            }
          });
        }}
      />
      <div className={styles.list} aria-live="polite" aria-busy={state === 'loading'}>
        {state === 'loading' && (
          <p className={`${styles.statePanel} muted`}>{t('apiKey.loading')}</p>
        )}
        {state === 'error' && (
          <div className={styles.errorPanel} role="alert">
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
        {state === 'ready' && items.length === 0 && (
          <p className={`${styles.statePanel} muted`}>{t('apiKey.empty')}</p>
        )}
        {items.map((item) => (
          <article className={styles.keyItem} key={item.apiKeyId}>
            <button
              type="button"
              className={styles.keyGuideButton}
              onClick={(event) => {
                clearSecret();
                setCopyStatus(null);
                setSecretSetupTab('mcp');
                setGuideItem(item);
                dialogReturnFocus.current = event.currentTarget;
              }}
            >
              <span className={styles.keyIdentity}>
                <strong>{item.name}</strong>
                <span className="muted">{item.prefix}</span>
              </span>
              <span className={styles.status} data-status={item.status}>
                {t(`apiKey.status.${item.status}`)}
              </span>
            </button>
            <button
              type="button"
              className={`button secondary ${styles.revokeButton}`}
              disabled={busy}
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
                      current.filter((value) => value.apiKeyId !== item.apiKeyId),
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
            className={`button secondary ${styles.loadMore}`}
            disabled={busy || continuationState === 'loading'}
            aria-busy={continuationState === 'loading'}
            onClick={() => loadPage(nextCursor, true)}
          >
            {continuationState === 'loading' ? t('apiKey.loadingMore') : t('apiKey.loadMore')}
          </button>
        )}
        {continuationState === 'error' && nextCursor !== null && (
          <div className={styles.errorPanel} role="alert">
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
      {(secret !== null || guideItem !== null) && (
        <dialog
          ref={dialog}
          className={styles.dialog}
          aria-labelledby="api-key-secret-title"
          onCancel={(event) => {
            event.preventDefault();
            if (secret !== null && !window.confirm(t('apiKey.closeConfirm'))) return;
            clearSetupModal();
          }}
        >
          <section>
            <h2 id="api-key-secret-title">
              {secret === null ? t('apiKey.guideTitle') : t('apiKey.secretTitle')}
            </h2>
            <p>{secret === null ? t('apiKey.guideDescription') : t('apiKey.secretDescription')}</p>
            {secret !== null ? (
              <>
                <div className={styles.secretValue}>
                  <code>{secret.value}</code>
                  <ClipboardCopyButton
                    value={secret.value}
                    autoFocus
                    onCopyFailed={() => setCopyStatus('failed')}
                  />
                </div>
                {copyStatus === 'failed' && (
                  <p className={styles.fieldError} role="alert">
                    {t('apiKey.copyFailed')}
                  </p>
                )}
                <div className={styles.securityNotice} role="note">
                  <strong>{t('apiKey.securityTitle')}</strong>
                  <span>{t('apiKey.securityDescription')}</span>
                </div>
              </>
            ) : (
              <div className={styles.guideKeySummary}>
                <strong>{guideItem?.name}</strong>
                <span className="muted">{guideItem?.prefix}</span>
              </div>
            )}
            <div className={styles.setupGuide}>
              <h3>{t('apiKey.setupTitle')}</h3>
              <div className={styles.setupTabs} role="tablist" aria-label={t('apiKey.setupTitle')}>
                <button
                  type="button"
                  id="api-key-mcp-tab"
                  className={styles.setupTab}
                  role="tab"
                  aria-selected={secretSetupTab === 'mcp'}
                  aria-controls="api-key-mcp-panel"
                  onClick={() => setSecretSetupTab('mcp')}
                >
                  {t('apiKey.mcpTab')}
                </button>
                <button
                  type="button"
                  id="api-key-environment-tab"
                  className={styles.setupTab}
                  role="tab"
                  aria-selected={secretSetupTab === 'environment'}
                  aria-controls="api-key-environment-panel"
                  onClick={() => setSecretSetupTab('environment')}
                >
                  {t('apiKey.environmentTab')}
                </button>
              </div>
              {secretSetupTab === 'mcp' ? (
                <section
                  id="api-key-mcp-panel"
                  className={styles.setupPanel}
                  role="tabpanel"
                  aria-labelledby="api-key-mcp-tab"
                >
                  <p>{t('apiKey.mcpDescription')}</p>
                  <ol>
                    <li>{t('apiKey.mcpStepFile')}</li>
                    <li>{t('apiKey.mcpStepSecret')}</li>
                    <li>{t('apiKey.mcpStepRestart')}</li>
                  </ol>
                  <div className={styles.exampleBlock}>
                    <div className={styles.exampleHeading}>
                      <strong>.mcp.json</strong>
                      <ClipboardCopyButton value={mcpJsonExample} className="button secondary" />
                    </div>
                    <pre>
                      <code>{mcpJsonExample}</code>
                    </pre>
                  </div>
                </section>
              ) : (
                <section
                  id="api-key-environment-panel"
                  className={styles.setupPanel}
                  role="tabpanel"
                  aria-labelledby="api-key-environment-tab"
                >
                  <p>{t('apiKey.environmentDescription')}</p>
                  <div className={styles.exampleBlock}>
                    <div className={styles.exampleHeading}>
                      <strong>macOS / Linux</strong>
                      <ClipboardCopyButton value={POSIX_ENV_EXAMPLE} className="button secondary" />
                    </div>
                    <pre>
                      <code>{POSIX_ENV_EXAMPLE}</code>
                    </pre>
                  </div>
                  <div className={styles.exampleBlock}>
                    <div className={styles.exampleHeading}>
                      <strong>Windows PowerShell</strong>
                      <ClipboardCopyButton
                        value={POWERSHELL_ENV_EXAMPLE}
                        className="button secondary"
                      />
                    </div>
                    <pre>
                      <code>{POWERSHELL_ENV_EXAMPLE}</code>
                    </pre>
                  </div>
                  <p>{t('apiKey.environmentCi')}</p>
                  <p>{t('apiKey.environmentRestart')}</p>
                </section>
              )}
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                if (secret !== null && !window.confirm(t('apiKey.closeConfirm'))) return;
                clearSetupModal();
              }}
            >
              {t('apiKey.close')}
            </button>
          </section>
        </dialog>
      )}
    </section>
  );
}
