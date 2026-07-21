'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { authSessionClient } from '../../lib/auth/session-client';
import { useI18n } from '../i18n/I18nProvider';
import styles from './LandingPage.module.css';

type SessionState = 'checking' | 'anonymous' | 'active';

export function LandingSessionActions() {
  const { t } = useI18n();
  const [sessionState, setSessionState] = useState<SessionState>('checking');

  useEffect(() => {
    let mounted = true;
    void authSessionClient()
      .reconcile()
      .then((result) => {
        if (!mounted) return;
        setSessionState(result.kind === 'ok' && result.value !== null ? 'active' : 'anonymous');
      })
      .catch(() => {
        if (mounted) setSessionState('anonymous');
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (sessionState === 'active') {
    return (
      <Link className={styles.headerPrimary} href="/boards">
        {t('landing.openSceneBoard')}
      </Link>
    );
  }

  return (
    <>
      <Link className={styles.headerLink} href="/login">
        {t('auth.signIn')}
      </Link>
      <Link
        className={styles.headerPrimary}
        href="/signup"
        aria-disabled={sessionState === 'checking'}
      >
        {t('landing.getStarted')}
      </Link>
    </>
  );
}
