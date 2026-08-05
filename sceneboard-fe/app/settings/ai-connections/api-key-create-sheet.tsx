'use client';

import { type RefObject, useState } from 'react';
import type { AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

import { useI18n } from '../../../components/i18n/I18nProvider';
import { formatApiKeyNameTimestamp } from './api-key-name';
import styles from './api-key-management.module.css';

const ALL_SCOPES: AccountApiKeyScopeV1[] = [
  'board:archive',
  'board:create',
  'board:read',
  'board:write',
  'export:read',
  'history:read',
];

export function ApiKeyCreateSheet({
  busy,
  onCreate,
  triggerRef,
}: {
  busy: boolean;
  onCreate(input: {
    displayName: string;
    scopes: AccountApiKeyScopeV1[];
    expiresInDays: number;
  }): void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<AccountApiKeyScopeV1[]>([...ALL_SCOPES]);
  const [days, setDays] = useState('90');
  const toggle = (scope: AccountApiKeyScopeV1) =>
    setSelected((current) =>
      current.includes(scope)
        ? current.filter((value) => value !== scope)
        : ALL_SCOPES.filter((value) => [...current, scope].includes(value)),
    );
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (selected.length === 0) return;
        const trimmedName = name.trim();
        const displayName =
          trimmedName.length > 0
            ? trimmedName
            : t('apiKey.defaultName', { timestamp: formatApiKeyNameTimestamp(new Date()) });
        setName(displayName);
        onCreate({
          displayName,
          scopes: selected,
          expiresInDays: Number(days),
        });
      }}
    >
      <label className={styles.field}>
        <span>{t('apiKey.name')}</span>
        <input
          className={styles.control}
          value={name}
          maxLength={80}
          aria-describedby="api-key-name-hint"
          onChange={(event) => setName(event.target.value)}
        />
        <span id="api-key-name-hint" className={styles.fieldHint}>
          {t('apiKey.nameAutoHint')}
        </span>
      </label>
      <fieldset className={styles.scopeFieldset}>
        <legend>{t('apiKey.scopes')}</legend>
        <div className={styles.scopeToolbar}>
          <button
            type="button"
            className={`button secondary ${styles.scopeAction}`}
            disabled={selected.length === ALL_SCOPES.length}
            onClick={() => setSelected([...ALL_SCOPES])}
          >
            {t('apiKey.selectAllScopes')}
          </button>
          <button
            type="button"
            className={`button secondary ${styles.scopeAction}`}
            disabled={selected.length === 0}
            onClick={() => setSelected([])}
          >
            {t('apiKey.clearAllScopes')}
          </button>
        </div>
        <div className={styles.scopeGrid}>
          {ALL_SCOPES.map((scope) => (
            <label className={styles.scopeOption} key={scope}>
              <input
                type="checkbox"
                checked={selected.includes(scope)}
                onChange={() => toggle(scope)}
              />
              <span>{scope}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className={styles.field}>
        <span>{t('apiKey.expires')}</span>
        <select
          className={styles.control}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        >
          <option value="30">{t('apiKey.expiry30')}</option>
          <option value="90">{t('apiKey.expiry90')}</option>
          <option value="365">{t('apiKey.expiry365')}</option>
        </select>
      </label>
      <button
        ref={triggerRef}
        className={`button ${styles.submit}`}
        disabled={busy || selected.length === 0}
      >
        {t('apiKey.create')}
      </button>
    </form>
  );
}
