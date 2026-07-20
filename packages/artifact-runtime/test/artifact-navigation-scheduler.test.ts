import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ArtifactNavigationSchedulerV1, type ArtifactBridgeMessageV1 } from '../src/bridge/index.js';

type NavigationMessage = Extract<ArtifactBridgeMessageV1, { type: `artifact.navigation.${string}` }>;

const fixture = () => {
  let now = 0;
  let callback: (() => void) | null = null;
  const emitted: NavigationMessage[] = [];
  const scheduler = new ArtifactNavigationSchedulerV1({
    now: () => now,
    schedule: (next) => { callback = next; return next; },
    cancel: () => { callback = null; },
    emit: (message) => emitted.push(message),
  });
  const flush = (advance = 34): void => {
    now += advance;
    const next = callback;
    callback = null;
    if (next !== null) next();
  };
  return { scheduler, emitted, flush };
};

test('navigation scheduler omits zero wheel sums and emits bounded residual chunks', () => {
  const { scheduler, emitted, flush } = fixture();
  scheduler.setEnabled(true);
  scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 1, yMillionth: 2, deltaY: 10 });
  scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 3, yMillionth: 4, deltaY: -10 });
  flush();
  assert.deepEqual(emitted, []);
  scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 5, yMillionth: 6, deltaY: 9_000 });
  flush();
  flush();
  flush();
  assert.deepEqual(emitted.map((message) => message.type === 'artifact.navigation.wheel' ? message.deltaY : null), [4_096, 4_096, 808]);
});

test('navigation scheduler preserves start, residual moves, terminal, then wheel fairness', () => {
  const { scheduler, emitted, flush } = fixture();
  scheduler.setEnabled(true);
  assert.equal(scheduler.start({ type: 'artifact.navigation.pan.start', pointerId: 7, xMillionth: 10, yMillionth: 20 }), true);
  scheduler.move(7, 20_000, -20_000);
  scheduler.end(7, 1_000, -1_000);
  scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 30, yMillionth: 40, deltaY: 2 });
  for (let index = 0; index < 5; index += 1) flush();
  assert.deepEqual(emitted.map((message) => message.type), [
    'artifact.navigation.pan.start',
    'artifact.navigation.pan.move',
    'artifact.navigation.pan.end',
    'artifact.navigation.wheel',
  ]);
  assert.deepEqual(emitted[1], { type: 'artifact.navigation.pan.move', pointerId: 7, deltaX: 16_384, deltaY: -16_384 });
  assert.deepEqual(emitted[2], { type: 'artifact.navigation.pan.end', pointerId: 7, deltaX: 4_616, deltaY: -4_616 });
});

test('navigation disable drops unopened pan and closes a visible pan once', () => {
  const unopened = fixture();
  unopened.scheduler.setEnabled(true);
  unopened.scheduler.start({ type: 'artifact.navigation.pan.start', pointerId: 1, xMillionth: 0, yMillionth: 0 });
  unopened.scheduler.setEnabled(false);
  unopened.flush();
  assert.deepEqual(unopened.emitted, []);

  const visible = fixture();
  visible.scheduler.setEnabled(true);
  visible.scheduler.start({ type: 'artifact.navigation.pan.start', pointerId: 2, xMillionth: 0, yMillionth: 0 });
  visible.flush();
  visible.scheduler.move(2, 50, 50);
  visible.scheduler.setEnabled(false);
  visible.flush();
  visible.flush();
  assert.deepEqual(visible.emitted.map((message) => message.type), ['artifact.navigation.pan.start', 'artifact.navigation.pan.cancel']);
});

test('navigation scheduler re-arms an early timer without consuming pending input', () => {
  const { scheduler, emitted, flush } = fixture();
  scheduler.setEnabled(true);
  scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 1, yMillionth: 2, deltaY: 1 });
  flush(0);
  scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 3, yMillionth: 4, deltaY: 2 });
  flush(1);
  assert.equal(emitted.length, 1);
  flush(33);
  assert.deepEqual(emitted.map((message) => message.type === 'artifact.navigation.wheel' ? message.deltaY : null), [1, 2]);
});

test('navigation scheduler keeps the exact 34 ms boundary across input frequencies', () => {
  for (const hz of [30, 60, 120, 240]) {
    const { scheduler, emitted, flush } = fixture();
    scheduler.setEnabled(true);
    scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 500_000, yMillionth: 500_000, deltaY: 1 });
    flush(0);
    const elapsed = Math.min(33, 1_000 / hz);
    scheduler.wheel({ type: 'artifact.navigation.wheel', xMillionth: 500_000, yMillionth: 500_000, deltaY: 2 });
    flush(elapsed);
    assert.equal(emitted.length, 1, `${hz}Hz emitted before 34 ms`);
    flush(34 - elapsed);
    assert.deepEqual(emitted.map((message) => message.type === 'artifact.navigation.wheel' ? message.deltaY : null), [1, 2], `${hz}Hz`);
  }
});
