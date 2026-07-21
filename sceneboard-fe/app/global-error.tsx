'use client';

import { useEffect, useState } from 'react';

import { DEFAULT_LOCALE, type Locale } from '../lib/i18n/catalog';
import { formatMessage, resolveClientLocale } from '../lib/i18n/locale';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const resolvedLocale = resolveClientLocale(document.cookie, navigator.languages);
    document.documentElement.lang = resolvedLocale;
    setLocale(resolvedLocale);
  }, []);

  return (
    <html lang={locale}>
      <body>
        <main
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            gap: '0.75rem',
          }}
        >
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {formatMessage(locale, 'error.somethingWrong')}
          </h1>
          <button onClick={() => reset()} style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}>
            {formatMessage(locale, 'error.tryAgain')}
          </button>
        </main>
      </body>
    </html>
  );
}
