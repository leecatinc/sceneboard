import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { I18nProvider } from '../components/i18n/I18nProvider';
import { LOCALE_COOKIE_NAME } from '../lib/i18n/catalog';
import { resolveRequestLocale } from '../lib/i18n/locale';
import { LocalizedSkipLink } from '../components/i18n/LocalizedSkipLink';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SceneBoard',
  description: 'A live visual workspace that AI can build with you.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  let locale = resolveRequestLocale(undefined, undefined);
  try {
    const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
    locale = resolveRequestLocale(
      cookieStore.get(LOCALE_COOKIE_NAME)?.value,
      requestHeaders.get('accept-language'),
    );
  } catch {
    // Static generation of built-in error pages (/404, /500) has no request scope;
    // fall back to the default locale instead of failing the build.
  }
  return (
    <html lang={locale}>
      <body>
        <I18nProvider initialLocale={locale}>
          <LocalizedSkipLink />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
