import assert from 'node:assert/strict';
import test from 'node:test';

import {
  elementIsActuallyVisibleV1,
  scheduleVisibleShareSignalV1,
  type VisibleSignalSchedulerV1,
} from '../../lib/share-analytics/visible-signal';

const installVisibilityGlobals = () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerHeight: 800, innerWidth: 1_200 },
  });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  return () => {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', priorWindow);
    if (priorStyle === undefined) Reflect.deleteProperty(globalThis, 'getComputedStyle');
    else Object.defineProperty(globalThis, 'getComputedStyle', priorStyle);
  };
};

test('visible signal requires two frames and one later task with repeated current checks', () => {
  const restore = installVisibilityGlobals();
  try {
    const frames: FrameRequestCallback[] = [];
    const tasks: Array<() => void> = [];
    const scheduler: VisibleSignalSchedulerV1 = {
      requestFrame: (callback) => (frames.push(callback), frames.length),
      cancelFrame: () => undefined,
      scheduleTask: (callback) => (tasks.push(callback), 1 as never),
      cancelTask: () => undefined,
    };
    const documentValue = { visibilityState: 'visible' } as Document;
    const element = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: 10,
        left: 10,
        right: 210,
        bottom: 110,
        width: 200,
        height: 100,
      }),
    } as HTMLElement;
    let count = 0;
    scheduleVisibleShareSignalV1({
      element,
      documentValue,
      scheduler,
      isCurrent: () => true,
      onVisible: () => {
        count += 1;
      },
    });
    assert.equal(count, 0);
    frames.shift()!(0);
    assert.equal(count, 0);
    frames.shift()!(16);
    assert.equal(count, 0);
    tasks.shift()!();
    assert.equal(count, 1);
  } finally {
    restore();
  }
});

test('hidden or stale transitions between paints emit no signal', () => {
  const restore = installVisibilityGlobals();
  try {
    const frames: FrameRequestCallback[] = [];
    const scheduler: VisibleSignalSchedulerV1 = {
      requestFrame: (callback) => (frames.push(callback), frames.length),
      cancelFrame: () => undefined,
      scheduleTask: () => 1 as never,
      cancelTask: () => undefined,
    };
    const documentValue = { visibilityState: 'visible' } as Document;
    const element = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: 1,
        left: 1,
        right: 2,
        bottom: 2,
        width: 1,
        height: 1,
      }),
    } as HTMLElement;
    let current = true;
    let count = 0;
    scheduleVisibleShareSignalV1({
      element,
      documentValue,
      scheduler,
      isCurrent: () => current,
      onVisible: () => {
        count += 1;
      },
    });
    frames.shift()!(0);
    current = false;
    frames.shift()!(16);
    assert.equal(count, 0);
    assert.equal(elementIsActuallyVisibleV1(element, documentValue), true);
    (documentValue as { visibilityState: string }).visibilityState = 'hidden';
    assert.equal(elementIsActuallyVisibleV1(element, documentValue), false);
  } finally {
    restore();
  }
});

test('cancellation after readiness prevents later frame settlement', () => {
  const restore = installVisibilityGlobals();
  try {
    const frames: FrameRequestCallback[] = [];
    const scheduler: VisibleSignalSchedulerV1 = {
      requestFrame: (callback) => (frames.push(callback), frames.length),
      cancelFrame: () => undefined,
      scheduleTask: () => 1 as never,
      cancelTask: () => undefined,
    };
    const element = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: 1,
        left: 1,
        right: 2,
        bottom: 2,
        width: 1,
        height: 1,
      }),
    } as HTMLElement;
    let count = 0;
    const cancel = scheduleVisibleShareSignalV1({
      element,
      documentValue: { visibilityState: 'visible' } as Document,
      scheduler,
      isCurrent: () => true,
      onVisible: () => {
        count += 1;
      },
    });
    cancel();
    frames.shift()!(0);
    assert.equal(count, 0);
  } finally {
    restore();
  }
});
