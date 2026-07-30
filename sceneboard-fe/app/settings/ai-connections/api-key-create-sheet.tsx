'use client';

import { type RefObject, useState } from 'react';
import type { AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

import { useI18n } from '../../../components/i18n/I18nProvider';
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
  onCreate(input: { displayName: string; scopes: AccountApiKeyScopeV1[]; expiresAt: string }): void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<AccountApiKeyScopeV1[]>(['board:read']);
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
        onCreate({
          displayName: name,
          scopes: selected,
          expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
        });
      }}
    >
      <label>
        {t('apiKey.name')}
        <input
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>{t('apiKey.scopes')}</legend>
        {ALL_SCOPES.map((scope) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={selected.includes(scope)}
              onChange={() => toggle(scope)}
            />
            {scope}
          </label>
        ))}
      </fieldset>
      <label>
        {t('apiKey.expires')}
        <select value={days} onChange={(event) => setDays(event.target.value)}>
          <option value="30">{t('apiKey.expiry30')}</option>
          <option value="90">{t('apiKey.expiry90')}</option>
          <option value="365">{t('apiKey.expiry365')}</option>
        </select>
      </label>
      <button ref={triggerRef} className="button" disabled={busy || selected.length === 0}>
        {t('apiKey.create')}
      </button>
    </form>
  );
}
