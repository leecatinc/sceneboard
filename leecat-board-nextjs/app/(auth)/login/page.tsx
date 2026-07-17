'use client';

import Link from 'next/link';

import { useI18n } from '../../../components/i18n/I18nProvider';
import { LoginForm } from './login-form';

export default function LoginPage() {
  const { t } = useI18n();
  return (
    <section className="card" style={{ marginTop: 22 }}>
      <h1>{t('auth.welcome')}</h1>
      <p className="muted">{t('auth.loginDescription')}</p>
      <LoginForm />
      <p className="muted">{t('auth.newTo')} <Link href="/signup">{t('auth.createAccount')}</Link></p>
    </section>
  );
}
