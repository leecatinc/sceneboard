const TAB_ID_BYTES = 16;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

export const createBoardStreamTabIdV1 = (): string => {
  const cryptoValue = globalThis.crypto;
  if (cryptoValue === undefined || typeof cryptoValue.getRandomValues !== 'function') {
    throw new Error('cryptographically secure browser randomness is unavailable');
  }
  const bytes = new Uint8Array(TAB_ID_BYTES);
  cryptoValue.getRandomValues(bytes);
  return toBase64Url(bytes);
};
