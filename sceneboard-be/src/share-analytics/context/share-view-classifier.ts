export const isSuppressedShareView = (input: {
  userAgent?: string | undefined;
  purpose?: string | undefined;
  secPurpose?: string | undefined;
}): boolean => {
  const purpose = `${input.purpose ?? ''} ${input.secPurpose ?? ''}`.toLowerCase();
  if (/\b(?:prefetch|prerender|preview)\b/u.test(purpose)) return true;
  const userAgent = (input.userAgent ?? '').toLowerCase();
  return /(?:bot|crawler|spider|slurp|facebookexternalhit|preview)/u.test(userAgent);
};
