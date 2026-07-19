import assert from 'node:assert/strict';
import test from 'node:test';

import { RetryController } from '../src/retry.js';

function createScheduler() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
    runNext() {
      const timer = timers.find((candidate) => !candidate.cleared && !candidate.ran);
      timer.ran = true;
      timer.callback();
      return timer;
    },
  };
}

test('retry controller schedules one timer and doubles after it fires', () => {
  const scheduler = createScheduler();
  const retry = new RetryController(scheduler);
  let calls = 0;

  assert.equal(retry.schedule(() => { calls += 1; }), 30_000);
  assert.equal(retry.schedule(() => { calls += 1; }), null);
  assert.equal(scheduler.timers.length, 1);
  scheduler.runNext();
  assert.equal(calls, 1);
  assert.equal(retry.schedule(() => {}), 60_000);
});

test('retry controller caps delay at 30 minutes', () => {
  const scheduler = createScheduler();
  const retry = new RetryController({
    ...scheduler,
    initialDelayMs: 900_000,
    maxDelayMs: 1_800_000,
  });

  assert.equal(retry.schedule(() => {}), 900_000);
  scheduler.runNext();
  assert.equal(retry.schedule(() => {}), 1_800_000);
  scheduler.runNext();
  assert.equal(retry.schedule(() => {}), 1_800_000);
});

test('reset and cancel clear pending work', () => {
  const scheduler = createScheduler();
  const retry = new RetryController(scheduler);
  retry.schedule(() => {});
  retry.reset();
  assert.equal(scheduler.timers[0].cleared, true);
  assert.equal(retry.pending, false);
  assert.equal(retry.schedule(() => {}), 30_000);
  retry.cancel();
  assert.equal(retry.pending, false);
});
