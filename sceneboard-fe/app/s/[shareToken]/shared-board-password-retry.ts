import type { PublicSharePasswordServerResult } from '../../../lib/api/public-share-server';

export const retryUnavailablePasswordAdmission = async (
  admit: () => Promise<PublicSharePasswordServerResult>,
  wait: () => Promise<void>,
): Promise<PublicSharePasswordServerResult> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await admit();
    if (result.kind !== 'unavailable' || attempt === 1) return result;
    await wait();
  }
  throw new TypeError('password admission retry exhausted without a result');
};
