'use client';

import { type FormEvent, useEffect, useState } from 'react';

import { useI18n } from '../../../components/i18n/I18nProvider';
import { authSessionClient } from '../../../lib/auth/session-client';
import { obtainFirebaseGoogleIdToken } from '../../../lib/auth/firebase-google.client';

export function LoginForm() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authSessionClient()
      .reconcile()
      .then((result) => {
        if (result.kind === 'unsupported_browser') setError(t('auth.unsupportedBrowser'));
        else if (result.kind === 'reconciliation_required') setError(t('auth.verificationHelp'));
        else if (result.value !== null) window.location.assign('/settings/ai-connections');
        else setReady(true);
      });
  }, [t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const result = await authSessionClient().login(
      String(data.get('email') ?? ''),
      String(data.get('password') ?? ''),
    );
    if (result.kind === 'ok' || result.kind === 'session_present')
      window.location.assign('/settings/ai-connections');
    else if (result.kind === 'invalid_credentials') setError(t('auth.invalidCredentials'));
    else setError(t('auth.loginFailed'));
    setBusy(false);
  }

  async function submitGoogle() {
    setBusy(true);
    setError(null);
    try {
      const idToken = await obtainFirebaseGoogleIdToken();
      const result = await authSessionClient().loginWithGoogle(idToken);
      if (result.kind === 'ok' || result.kind === 'session_present') {
        window.location.assign('/settings/ai-connections');
        return;
      }
      if (result.kind === 'invalid_credentials') setError(t('auth.googleInvalid'));
      else setError(t('auth.googleFailed'));
    } catch {
      setError(t('auth.googleFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        {t('common.email')}
        <input name="email" type="email" autoComplete="email" required disabled={!ready || busy} />
      </label>
      <label className="field">
        {t('common.password')}
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={!ready || busy}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="button" disabled={!ready || busy}>
        {busy ? t('auth.signingIn') : t('auth.signIn')}
      </button>
      <button
        className="button secondary"
        type="button"
        disabled={!ready || busy}
        onClick={() => void submitGoogle()}
      >
        {t('auth.signInWithGoogle')}
      </button>
    </form>
  );
}
