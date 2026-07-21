'use client';

import { LOCALE_NAMES, SUPPORTED_LOCALES, type Locale } from '../../lib/i18n/catalog';
import { useI18n } from './I18nProvider';

export function LanguageSelect({
  id = 'language',
  autoFocus = false,
}: {
  id?: string;
  autoFocus?: boolean;
}) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="field" htmlFor={id}>
      {t('settings.languageTitle')}
      <select
        id={id}
        value={locale}
        autoFocus={autoFocus}
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
