export type PublicRenderReadyIdentityV1 = Readonly<{
  boardId: string;
  revisionId: string;
  pageId: string;
  renderEpoch: number;
}>;

const RESOURCE_SELECTOR = '[data-public-render-resource="image"]';
const ERROR_SELECTOR = '[data-public-render-error="true"]';

const imageIsSettled = (element: Element): boolean => {
  if (!(element instanceof HTMLImageElement)) return false;
  return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
};

export const publicRenderTreeIsReadyV1 = (root: HTMLElement): boolean => {
  if (!root.isConnected || root.querySelector(ERROR_SELECTOR) !== null) return false;
  return [...root.querySelectorAll(RESOURCE_SELECTOR)].every(imageIsSettled);
};

export const waitForPublicRenderReadyV1 = (
  root: HTMLElement,
  onReady: () => void,
): (() => void) => {
  let active = true;
  let cancelled = false;
  let observer: MutationObserver | null = null;
  const settle = () => {
    if (!active || !publicRenderTreeIsReadyV1(root)) return;
    active = false;
    root.removeEventListener('load', settle, true);
    root.removeEventListener('error', settle, true);
    observer?.disconnect();
    queueMicrotask(() => {
      if (!cancelled) onReady();
    });
  };
  observer = new MutationObserver(settle);
  observer.observe(root, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  root.addEventListener('load', settle, true);
  root.addEventListener('error', settle, true);
  queueMicrotask(settle);
  return () => {
    cancelled = true;
    active = false;
    root.removeEventListener('load', settle, true);
    root.removeEventListener('error', settle, true);
    observer?.disconnect();
  };
};
