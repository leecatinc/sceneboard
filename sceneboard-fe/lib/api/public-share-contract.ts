import {
  PublicContextIdParserV1,
  PublicShareStateParserV1,
  type PublicShareStateV1,
} from '@sceneboard/board-schema';

export type PublicShareClientState = PublicShareStateV1;

export const decodePublicShareBootstrapResponse = (input: unknown): PublicShareClientState => {
  const parsed = PublicShareStateParserV1.parse(input);
  if (!parsed.ok) throw new TypeError('public share response is corrupt');
  return parsed.data.value;
};

export type PublicShareRevalidationState = Exclude<
  PublicShareClientState,
  { state: 'password-required' }
>;

export const decodePublicShareRevalidationResponse = (
  input: unknown,
): PublicShareRevalidationState => {
  const state = decodePublicShareBootstrapResponse(input);
  if (state.state === 'password-required')
    throw new TypeError('public share revalidation response is corrupt');
  return state;
};

export const decodePublicShareClientState = decodePublicShareBootstrapResponse;

const canonicalOrigin = (value: string): string => {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  )
    throw new TypeError('public share API origin is invalid');
  return parsed.origin;
};

export const fetchPublicShareRevalidation = async (input: {
  apiOrigin: string;
  contextId: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<PublicShareRevalidationState> => {
  const contextId = PublicContextIdParserV1.parse(input.contextId);
  if (!contextId.ok) throw new TypeError('public share context is invalid');
  const response = await (input.fetcher ?? fetch)(
    `${canonicalOrigin(input.apiOrigin)}/api/v1/public/share-contexts/${contextId.data.value}`,
    {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'manual',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  const state = decodePublicShareRevalidationResponse(await response.json());
  const validStatus =
    (response.status === 200 && state.state === 'ready') ||
    (response.status === 429 && state.state === 'rate-limited') ||
    ([400, 404, 405, 503].includes(response.status) && state.state === 'unavailable');
  if (!validStatus) throw new TypeError('public share revalidation status mismatch');
  const retryAfter = response.headers.get('retry-after');
  if (
    (state.state === 'rate-limited' && retryAfter !== String(state.retryAfterSeconds)) ||
    (state.state !== 'rate-limited' && response.status !== 503 && retryAfter !== null) ||
    (response.status === 503 && retryAfter !== '1')
  )
    throw new TypeError('public share revalidation retry mismatch');
  return state;
};
