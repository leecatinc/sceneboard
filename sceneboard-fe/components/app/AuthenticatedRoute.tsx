'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import { authSessionClient } from '../../lib/auth/session-client';

type Admission = 'checking' | 'active' | 'retry';

export function AuthenticatedRoute({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [admission, setAdmission] = useState<Admission>('checking');

  const reconcile = useCallback(async () => {
    setAdmission('checking');
    const result = await authSessionClient().reconcile();
    if (result.kind === 'ok' && result.value !== null) setAdmission('active');
    else if (result.kind === 'ok') window.location.replace('/login');
    else setAdmission('retry');
  }, []);

  useEffect(() => {
    void reconcile();
  }, [reconcile]);

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
