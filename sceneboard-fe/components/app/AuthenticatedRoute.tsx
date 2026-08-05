'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import { authSessionClient, type AuthSessionClient } from '../../lib/auth/session-client';

type Admission = 'checking' | 'active' | 'retry';
const SESSION_RENEWAL_LEAD_MS = 5 * 60 * 1_000;

export function AuthenticatedRoute({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [admission, setAdmission] = useState<Admission>('checking');
  const invalidationUnsubscribe = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  const admissionAttemptEpoch = useRef(0);

  const replaceInvalidationSubscription = useCallback(
    async (client: AuthSessionClient, isActive: () => boolean = () => true) => {
      const coordinator = client.sharedCoordinator();
      const bound = await coordinator.bindCurrentGeneration();
      if (bound.kind !== 'bound' || !isActive()) return false;
      invalidationUnsubscribe.current?.();
      invalidationUnsubscribe.current = coordinator.subscribeGenerationInvalidation(
        bound.binding,
        () => window.location.reload(),
      );
      return true;
    },
    [],
  );

  const reconcile = useCallback(async () => {
    const attemptEpoch = admissionAttemptEpoch.current + 1;
    admissionAttemptEpoch.current = attemptEpoch;
    const isCurrentAttempt = () =>
      mounted.current && admissionAttemptEpoch.current === attemptEpoch;
    invalidationUnsubscribe.current?.();
    invalidationUnsubscribe.current = null;
    setAdmission('checking');
    const client = authSessionClient();
    const result = await client.reconcile();
    if (!isCurrentAttempt()) return;
    if (result.kind === 'ok' && result.value !== null) {
      if (!(await replaceInvalidationSubscription(client, isCurrentAttempt))) {
        if (isCurrentAttempt()) setAdmission('retry');
        return;
      }
      if (isCurrentAttempt()) setAdmission('active');
    } else if (result.kind === 'ok') window.location.replace('/login');
    else setAdmission('retry');
  }, [replaceInvalidationSubscription]);

  useEffect(() => {
    mounted.current = true;
    void reconcile();
    return () => {
      mounted.current = false;
      admissionAttemptEpoch.current += 1;
      invalidationUnsubscribe.current?.();
      invalidationUnsubscribe.current = null;
    };
  }, [reconcile]);

  useEffect(() => {
    if (admission !== 'active') return;
    const client = authSessionClient();
    const snapshot = client.snapshot();
    if (snapshot === null) return;
    let active = true;
    let renewing = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!active) return;
      const current = client.snapshot();
      if (current === null) {
        setAdmission('retry');
        return;
      }
      const remaining = Date.parse(current.session.idleExpiresAt) - Date.now();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void renew(), Math.max(0, remaining - SESSION_RENEWAL_LEAD_MS));
    };
    const renew = async () => {
      if (!active || renewing) return;
      renewing = true;
      invalidationUnsubscribe.current?.();
      invalidationUnsubscribe.current = null;
      const result = await client.renew();
      if (!active) return;
      if (result.kind !== 'ok' || !(await replaceInvalidationSubscription(client, () => active))) {
        if (active) setAdmission('retry');
        return;
      }
      renewing = false;
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const current = client.snapshot();
      if (current === null) {
        setAdmission('retry');
        return;
      }
      const remaining = Date.parse(current.session.idleExpiresAt) - Date.now();
      if (remaining <= SESSION_RENEWAL_LEAD_MS) {
        if (timer !== null) clearTimeout(timer);
        void renew();
      }
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [admission, replaceInvalidationSubscription]);

  if (admission === 'checking')
    return (
      <section className="route-state" role="status">
        <span className="spinner" />
        {t('auth.verify')}
      </section>
    );
  if (admission === 'retry')
    return (
      <section className="route-state" role="alert">
        <h2>{t('auth.verificationPaused')}</h2>
        <p>{t('auth.verificationHelp')}</p>
        <button className="button" onClick={() => void reconcile()}>
          {t('auth.retryVerification')}
        </button>
      </section>
    );
  return children;
}
