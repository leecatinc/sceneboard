'use client';

import { type FormEvent, useState } from 'react';

import { authSessionClient, type PasswordChangeClientResult } from '../../lib/auth/session-client';
import { useI18n } from '../i18n/I18nProvider';
import styles from './PasswordChangeForm.module.css';

export function PasswordChangeForm() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get('currentPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmPassword = String(data.get('confirmPassword') ?? '');
    setError(null);
    setSuccess(null);
    if (newPassword !== confirmPassword) {
      setError(t('settings.passwordMismatch'));
      return;
    }

    setBusy(true);
    const result = await authSessionClient().changePassword(currentPassword, newPassword);
    if (result.kind === 'ok') {
      form.reset();
      setSuccess(t('settings.passwordChanged'));
    } else {
      setError(passwordChangeError(result));
    }
    setBusy(false);
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className="field">
        {t('settings.currentPassword')}
        <input
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
          autoFocus
        />
      </label>
      <label className="field">
        {t('settings.newPassword')}
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          disabled={busy}
          aria-describedby="new-password-hint"
        />
      </label>
      <label className="field">
        {t('settings.confirmPassword')}
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          disabled={busy}
        />
      </label>
      <span id="new-password-hint" className={styles.hint}>
        {t('auth.passwordHint')}
      </span>
      <button className="button" disabled={busy}>
        {busy ? t('settings.changingPassword') : t('user.changePassword')}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
    </form>
  );

  function passwordChangeError(result: PasswordChangeClientResult): string {
    if (result.kind === 'api_error') {
      if (result.code === 'AUTH_CURRENT_PASSWORD_INVALID')
        return t('settings.currentPasswordInvalid');
      if (result.code === 'AUTH_PASSWORD_UNCHANGED') return t('settings.passwordUnchanged');
      if (result.code === 'AUTH_PASSWORD_POLICY') return t('auth.passwordHint');
      if (result.code === 'RATE_LIMITED') return t('settings.passwordRateLimited');
    }
    return t('settings.passwordChangeFailed');
  }
}
