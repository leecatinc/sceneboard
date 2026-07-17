'use client';

import Link from 'next/link';

import { useI18n } from '../../../components/i18n/I18nProvider';
import { SignupForm } from './signup-form';

export default function SignupPage() {
  const { t } = useI18n();
  return (
    <section className="card" style={{ marginTop: 22 }}>
      <h1>{t('auth.createWorkspace')}</h1>
      <p className="muted">{t('auth.signupDescription')}</p>
      <SignupForm />
      <p className="muted">{t('auth.alreadyAccount')} <Link href="/login">{t('auth.signIn')}</Link></p>
    </section>
  );
}
