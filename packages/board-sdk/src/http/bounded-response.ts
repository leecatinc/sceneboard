export type BoundedResponseFailureV1 = 'body_too_large' | 'response';

export const readBoundedResponseBodyV1 = async (
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array | BoundedResponseFailureV1> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^(0|[1-9][0-9]*)$/.test(contentLength)) {
    const length = Number(contentLength);
    if (Number.isSafeInteger(length) && length > limit) {
      await response.body?.cancel().catch(() => undefined);
      return 'body_too_large';
    }
  }
  if (response.body === null) return 'response';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return 'body_too_large';
      }
      chunks.push(next.value);
    }
  } catch {
    return 'response';
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
