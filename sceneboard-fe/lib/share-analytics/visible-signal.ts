export type VisibleSignalSchedulerV1 = Readonly<{
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  scheduleTask: (callback: () => void) => ReturnType<typeof setTimeout>;
  cancelTask: (handle: ReturnType<typeof setTimeout>) => void;
}>;

const BROWSER_SCHEDULER_V1: VisibleSignalSchedulerV1 = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  scheduleTask: (callback) => setTimeout(callback, 0),
  cancelTask: (handle) => clearTimeout(handle),
};

export const elementIsActuallyVisibleV1 = (
  element: HTMLElement,
  documentValue: Document = document,
): boolean => {
  if (documentValue.visibilityState !== 'visible' || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  )
    return false;
  const style = getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    Number.parseFloat(style.opacity || '1') > 0
  );
};

export const scheduleVisibleShareSignalV1 = (input: {
  element: HTMLElement;
  isCurrent: () => boolean;
  onVisible: () => void;
  documentValue?: Document;
  scheduler?: VisibleSignalSchedulerV1;
}): (() => void) => {
  const scheduler = input.scheduler ?? BROWSER_SCHEDULER_V1;
  const documentValue = input.documentValue ?? document;
  let active = true;
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let task: ReturnType<typeof setTimeout> | null = null;
  const eligible = () =>
    active && input.isCurrent() && elementIsActuallyVisibleV1(input.element, documentValue);
  if (!eligible()) return () => undefined;
  firstFrame = scheduler.requestFrame(() => {
    firstFrame = null;
    if (!eligible()) return;
    secondFrame = scheduler.requestFrame(() => {
      secondFrame = null;
      if (!eligible()) return;
      task = scheduler.scheduleTask(() => {
        task = null;
        if (!eligible()) return;
        active = false;
        input.onVisible();
      });
    });
  });
  return () => {
    active = false;
    if (firstFrame !== null) scheduler.cancelFrame(firstFrame);
    if (secondFrame !== null) scheduler.cancelFrame(secondFrame);
    if (task !== null) scheduler.cancelTask(task);
  };
};
