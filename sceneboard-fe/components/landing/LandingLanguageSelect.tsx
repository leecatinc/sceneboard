'use client';

import { LOCALE_NAMES, SUPPORTED_LOCALES, type Locale } from '../../lib/i18n/catalog';
import { useI18n } from '../i18n/I18nProvider';
import styles from './LandingPage.module.css';

export function LandingLanguageSelect() {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className={styles.languageControl}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z" />
      </svg>
      <select
        value={locale}
        aria-label={t('settings.languageTitle')}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {SUPPORTED_LOCALES.map((supportedLocale) => (
          <option key={supportedLocale} value={supportedLocale}>
            {LOCALE_NAMES[supportedLocale]}
          </option>
        ))}
      </select>
    </label>
  );
}
