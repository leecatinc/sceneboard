const PRESENTATION_DEMO_ORIGINS = new Set([
  'https://sceneboard.leecat.co.kr',
  'https://sceneboard.dev',
]);

const PERSISTENT_SHARE_PATH = /^\/s\/share_[A-Za-z0-9_-]{22}_g([1-9][0-9]{0,15})$/u;

export const resolvePresentationDemoUrl = (rawValue: string | undefined): string | null => {
  if (rawValue === undefined || rawValue.length === 0 || rawValue.trim() !== rawValue) return null;

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    !PRESENTATION_DEMO_ORIGINS.has(url.origin) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  )
    return null;

  const match = PERSISTENT_SHARE_PATH.exec(url.pathname);
  if (match === null) return null;
  const generation = Number(match[1]);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;

  return url.toString();
};
