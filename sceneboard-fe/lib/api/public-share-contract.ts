import {
  MediaIdParserV1,
  PageIdParserV1,
  PublicContextIdParserV1,
  PublicShareStateParserV1,
  type BoardNodeV1,
  type PublicShareStateV1,
} from '@sceneboard/board-schema';
import type { MediaResolverV1 } from '@sceneboard/board-ui/renderer';

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

const UNAVAILABLE_MEDIA = Object.freeze({ error: 'unavailable' as const });

const nodeContainsMediaV1 = (node: BoardNodeV1 | null, mediaId: string): boolean => {
  if (node === null) return false;
  if (node.type === 'content.image')
    return node.source.type === 'media' && node.source.mediaId === mediaId;
  if (node.type === 'layout.tabs')
    return node.tabs.some((item) => nodeContainsMediaV1(item.node, mediaId));
  if (node.type === 'layout.split' || node.type === 'layout.grid' || node.type === 'layout.canvas')
    return node.children.some((item) => nodeContainsMediaV1(item.node, mediaId));
  return false;
};

export const createPublicShareMediaResolverV1 = (
  accepted: Extract<PublicShareClientState, { state: 'ready' }>,
): MediaResolverV1 => {
  const parsed = PublicShareStateParserV1.parse(accepted);
  if (!parsed.ok || parsed.data.value.state !== 'ready') return () => UNAVAILABLE_MEDIA;
  const ready = parsed.data.value;

  return (input) => {
    const mediaId = MediaIdParserV1.parse(input.mediaId);
    const pageId = PageIdParserV1.parse(input.pageId);
    if (
      !mediaId.ok ||
      !pageId.ok ||
      input.boardId !== ready.projection.boardId ||
      input.revisionId !== ready.projection.revisionId
    )
      return UNAVAILABLE_MEDIA;
    const page = ready.projection.document.pages.find(
      (candidate) => candidate.pageId === pageId.data.value,
    );
    if (page === undefined || !nodeContainsMediaV1(page.scene.root, mediaId.data.value))
      return UNAVAILABLE_MEDIA;
    const matches = ready.projection.media.filter(
      (resource) => resource.mediaId === mediaId.data.value,
    );
    const resource = matches[0];
    if (matches.length !== 1 || resource === undefined) return UNAVAILABLE_MEDIA;
    return Object.freeze({
      url: resource.url,
      metadata: Object.freeze({
        mime: resource.mime,
        width: resource.width,
        height: resource.height,
        etag: resource.etag,
      }),
    });
  };
};

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
