'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { localeCookie, formatMessage } from '../../lib/i18n/locale';
import type { Locale, MessageKey } from '../../lib/i18n/catalog';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
  formatDateTime: (value: string | Date) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    document.cookie = localeCookie(nextLocale);
    document.documentElement.lang = nextLocale;
    setLocaleState(nextLocale);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => formatMessage(locale, key, values),
      formatDateTime: (input) =>
        new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(typeof input === 'string' ? new Date(input) : input),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = (): I18nContextValue => {
  const value = useContext(I18nContext);
  if (value === null) throw new TypeError('useI18n must be used within I18nProvider');
  return value;
};
