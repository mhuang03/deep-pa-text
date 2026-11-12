import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultClock } from '../../../src/container/clock.js';

test('reads the globals at call time so mocks are honoured', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5000 });
  t.mock.method(Math, 'random', () => 0.75);
  const clock = defaultClock();
  assert.equal(clock.now(), 5000);
  assert.equal(clock.random(), 0.75);
});

test('sleep resolves after the timer fires and clearTimeout cancels one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = defaultClock();
  let done = false;
  const sleeping = clock.sleep(100).then(() => { done = true; });
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await sleeping;
  assert.equal(done, true);
  const fired = [];
  clock.clearTimeout(clock.setTimeout(() => fired.push('x'), 10));
  t.mock.timers.tick(20);
  assert.deepEqual(fired, []);
});

test('each call returns an independent clock', () => {
  assert.notEqual(defaultClock(), defaultClock());
});
