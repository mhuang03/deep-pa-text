import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../../../src/util/withTimeout.js';

const createTimers = () => {
  const timers = { scheduled: [], cleared: [] };
  timers.setTimeout = (fn, ms) => {
    timers.scheduled.push({ fn, ms });
    return timers.scheduled.length;
  };
  timers.clearTimeout = (handle) => timers.cleared.push(handle);
  return timers;
};

const options = (timers) => ({
  ms: 50, label: 'thing', setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
});

test('resolves with the promise value and clears the timer', async () => {
  const timers = createTimers();
  assert.equal(await withTimeout(Promise.resolve('ok'), options(timers)), 'ok');
  assert.equal(timers.scheduled[0].ms, 50);
  assert.deepEqual(timers.cleared, [1]);
});

test('rejects with the promise error and clears the timer', async () => {
  const timers = createTimers();
  await assert.rejects(withTimeout(Promise.reject(new Error('bad')), options(timers)), { message: 'bad' });
  assert.deepEqual(timers.cleared, [1]);
});

test('rejects with a labelled timeout when the timer fires first', async () => {
  const timers = createTimers();
  const pending = withTimeout(new Promise(() => {}), options(timers));
  timers.scheduled[0].fn();
  await assert.rejects(pending, { message: 'thing timed out after 50 ms' });
});

test('a late settlement after the timeout is ignored', async () => {
  const timers = createTimers();
  let finish;
  const pending = withTimeout(new Promise((resolve) => { finish = resolve; }), options(timers));
  timers.scheduled[0].fn();
  await assert.rejects(pending, /timed out/);
  finish('late');
  await Promise.resolve();
});
