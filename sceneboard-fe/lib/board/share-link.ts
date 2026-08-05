export const buildPublicShareLocatorV1 = (shareId: string, accessGeneration: number): string => {
  if (!/^share_[A-Za-z0-9_-]{22}$/u.test(shareId)) throw new TypeError('invalid share ID');
  if (!Number.isSafeInteger(accessGeneration) || accessGeneration < 1)
    throw new TypeError('invalid access generation');
  return `${shareId}_g${accessGeneration}`;
};

export const buildPublicShareUrlV1 = (
  origin: string,
  shareId: string,
  accessGeneration: number,
): string => {
  const base = new URL(origin);
  if (base.origin !== origin) throw new TypeError('share origin must be canonical');
  const locator = buildPublicShareLocatorV1(shareId, accessGeneration);
  return new URL(`/s/${locator}`, base).toString();
};
