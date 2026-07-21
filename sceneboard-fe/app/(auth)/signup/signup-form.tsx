'use client';

import { type FormEvent, useEffect, useState } from 'react';

import { useI18n } from '../../../components/i18n/I18nProvider';
import { authSessionClient } from '../../../lib/auth/session-client';

export function SignupForm() {
  const { locale, t } = useI18n();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [verificationTicket, setVerificationTicket] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [resendAfter, setResendAfter] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authSessionClient()
      .reconcile()
      .then((result) => {
        if (result.kind === 'ok' && result.value === null) setReady(true);
        else if (result.kind === 'ok') window.location.assign('/settings/ai-connections');
        else setError(t('auth.sessionFailed'));
      });
  }, [t]);

  useEffect(() => {
    if (resendAfter <= 0) return;
    const timer = window.setInterval(
      () => setResendAfter((current) => Math.max(0, current - 1)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [resendAfter]);

  async function sendCode() {
    if (!ready || busy || email.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await authSessionClient().requestEmailVerification(email, locale);
    if (result.kind === 'ok') {
      setCodeSent(true);
      setVerificationTicket(null);
      setResendAfter(result.value.resendAfterSeconds);
    } else {
      setError(emailVerificationError(result));
    }
    setBusy(false);
  }

  async function verifyCode(code: string) {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const result = await authSessionClient().confirmEmailVerification(email, code);
    if (result.kind === 'ok') setVerificationTicket(result.value.verificationTicket);
    else setError(emailVerificationError(result));
    setBusy(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const code = String(data.get('verificationCode') ?? '');
    if (verificationTicket === null) {
      await verifyCode(code);
      return;
    }
    const result = await authSessionClient().signup(
      email,
      String(data.get('password') ?? ''),
      verificationTicket,
    );
    if (result.kind === 'ok' || result.kind === 'session_present')
      window.location.assign('/settings/ai-connections');
    else if (result.kind === 'email_in_use') setError(t('auth.emailInUse'));
    else if (result.kind === 'verification_required') {
      setVerificationTicket(null);
      setCodeSent(false);
      setError(t('auth.signupVerificationExpired'));
    } else if (result.kind === 'invalid_credentials') setError(t('auth.signupInvalid'));
    else setError(t('auth.signupFailed'));
    setBusy(false);
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        {t('common.email')}
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={!ready || busy || verificationTicket !== null}
          onChange={(event) => {
            setEmail(event.target.value);
            setCodeSent(false);
            setVerificationTicket(null);
            setResendAfter(0);
            setError(null);
          }}
        />
      </label>
      {verificationTicket === null && (
        <button
          className="button secondary"
          type="button"
          disabled={!ready || busy || email.length === 0 || resendAfter > 0}
          onClick={() => void sendCode()}
        >
          {busy
            ? t('auth.sendingCode')
            : resendAfter > 0
              ? t('auth.resendCountdown', { seconds: resendAfter })
              : codeSent
                ? t('auth.resendCode')
                : t('auth.sendCode')}
        </button>
      )}
      {codeSent && verificationTicket === null && (
        <label className="field">
          {t('auth.verificationCode')}
          <input
            name="verificationCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            required
            disabled={!ready || busy}
          />
        </label>
      )}
      {verificationTicket !== null && (
        <p className="success" role="status">
          {t('auth.emailVerified')}
        </p>
      )}
      {verificationTicket !== null && (
        <>
          <label className="field">
            {t('common.password')}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              disabled={!ready || busy}
              aria-describedby="password-hint"
            />
          </label>
          <span id="password-hint" className="muted">
            {t('auth.passwordHint')}
          </span>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {codeSent && verificationTicket === null && (
        <button className="button" disabled={!ready || busy}>
          {busy ? t('auth.verifyingCode') : t('auth.verifyCode')}
        </button>
      )}
      {verificationTicket !== null && (
        <button className="button" disabled={!ready || busy}>
          {busy ? t('auth.creating') : t('auth.createAccount')}
        </button>
      )}
    </form>
  );

  function emailVerificationError(
    result: Awaited<ReturnType<ReturnType<typeof authSessionClient>['requestEmailVerification']>>,
  ): string {
    if (result.kind === 'api_error') {
      if (result.code === 'AUTH_EMAIL_IN_USE') return t('auth.emailInUse');
      if (result.code === 'AUTH_EMAIL_VERIFICATION_INVALID')
        return t('auth.invalidVerificationCode');
      if (result.code === 'RATE_LIMITED') {
        return result.retryAfterSeconds === null
          ? t('auth.verificationRateLimited')
          : t('auth.verificationRetryAfter', { seconds: result.retryAfterSeconds });
      }
    }
    return t('auth.verificationFailed');
  }
}
