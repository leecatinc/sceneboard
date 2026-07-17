import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  MESSAGES,
  SUPPORTED_LOCALES,
  type Locale,
  type MessageKey,
} from './catalog';

const localeSet = new Set<string>(SUPPORTED_LOCALES);

export const normalizeLocale = (value: string | null | undefined): Locale | null => {
  if (value === null || value === undefined) return null;
  const candidate = value.trim().replaceAll('_', '-');
  if (localeSet.has(candidate)) return candidate as Locale;
  const normalized = candidate.toLowerCase();
  if (normalized.startsWith('zh-hant') || /^zh-(tw|hk|mo)(?:-|$)/u.test(normalized)) return 'zh-TW';
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('pt')) return 'pt-BR';
  const matched = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === normalized.split('-')[0]);
  return matched ?? null;
};

export const localeFromAcceptLanguage = (header: string | null | undefined): Locale => {
  if (header === null || header === undefined) return DEFAULT_LOCALE;
  const candidates = header.split(',').map((entry, index) => {
    const [tag, ...parameters] = entry.trim().split(';');
    const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
    const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.trim().slice(2));
    return { tag, quality: Number.isFinite(quality) ? quality : 0, index };
  }).sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const candidate of candidates) {
    if (candidate.quality <= 0) continue;
    const locale = normalizeLocale(candidate.tag);
    if (locale !== null) return locale;
  }
  return DEFAULT_LOCALE;
};

export const resolveRequestLocale = (cookieLocale: string | null | undefined, acceptLanguage: string | null | undefined): Locale => (
  normalizeLocale(cookieLocale) ?? localeFromAcceptLanguage(acceptLanguage)
);

export const formatMessage = (
  locale: Locale,
  key: MessageKey,
  values: Readonly<Record<string, string | number>> = {},
): string => Object.entries(values).reduce(
  (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
  MESSAGES[locale][key],
);

export const localeCookie = (locale: Locale): string => (
  `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
);
