import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from '../../../src/bot/lifecycle.js';

const setup = ({ destroy = async () => {}, close = () => {}, onSleep = () => {} } = {}) => {
  const events = [];
  const cleared = [];
  const lifecycle = createLifecycle({
    client: { destroy: async () => { events.push('destroy'); await destroy(); } },
    closeDatabase: () => { events.push('close'); close(); },
    clock: {
      setInterval: (fn, ms) => ({ fn, ms }),
      clearInterval: (handle) => cleared.push(handle),
      sleep: async (ms) => { events.push(`sleep ${ms}`); await onSleep(); },
    },
    logger: {
      info: (m) => events.push(`info ${m}`),
      warn: (m) => events.push(`warn ${m}`),
      error: (m) => events.push(`error ${m}`),
    },
    exit: (code) => events.push(`exit ${code}`),
    config: { lifecycle: { graceMs: 300, pollMs: 100 } },
  });
  return { lifecycle, events, cleared };
};

test('shutdown destroys the client, closes the database, then exits with the code', async () => {
  const { lifecycle, events } = setup();
  await lifecycle.shutdown({ reason: 'SIGTERM', code: 0 });
  assert.deepEqual(events, ['info Shutting down: SIGTERM', 'destroy', 'close', 'exit 0']);
});

test('shutdown waits for a tracked handler and proceeds once it finishes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { lifecycle, events } = setup({ onSleep: () => release() });
  const slow = lifecycle.track(() => gate, 'slow');
  const running = slow();
  await lifecycle.shutdown({ code: 0 });
  await running;
  assert.deepEqual(events, ['sleep 100', 'destroy', 'close', 'exit 0']);
});

test('shutdown gives up after the grace period and names the abandoned handler', async () => {
  const { lifecycle, events } = setup();
  lifecycle.track(() => new Promise(() => {}), 'stuck')();
  await lifecycle.shutdown({ code: 0 });
  assert.equal(events.filter((e) => e.startsWith('sleep')).length, 3);
  assert.ok(events.some((e) => e.startsWith('warn') && e.includes('1 handler') && e.includes('stuck')));
  assert.equal(events.at(-1), 'exit 0');
});

test('a graceMs of 0 does not wait', async () => {
  const { lifecycle, events } = setup();
  lifecycle.track(() => new Promise(() => {}), 'stuck')();
  await lifecycle.shutdown({ code: 1, graceMs: 0 });
  assert.equal(events.some((e) => e.startsWith('sleep')), false);
  assert.equal(events.at(-1), 'exit 1');
});

test('handlers invoked after shutdown began return without running', async () => {
  const { lifecycle } = setup();
  const calls = [];
  const wrapped = lifecycle.track(() => calls.push('ran'));
  await wrapped();
  const done = lifecycle.shutdown({ code: 0 });
  assert.equal(lifecycle.isShuttingDown(), true);
  assert.equal(await wrapped(), undefined);
  await done;
  assert.deepEqual(calls, ['ran']);
});

test('shutdown is idempotent and returns the first promise', async () => {
  const { lifecycle, events } = setup();
  const first = lifecycle.shutdown({ reason: 'a', code: 0 });
  const second = lifecycle.shutdown({ reason: 'b', code: 1 });
  assert.equal(first, second);
  await first;
  assert.equal(events.filter((e) => e.startsWith('exit')).length, 1);
  assert.equal(events.at(-1), 'exit 0');
});

test('a failing destroy is logged and the database is still closed and exit still happens', async () => {
  const { lifecycle, events } = setup({ destroy: () => { throw new Error('gone'); } });
  await lifecycle.shutdown({ code: 0 });
  assert.ok(events.some((e) => e.startsWith('error') && e.includes('Discord client')));
  assert.deepEqual(events.filter((e) => ['close', 'exit 0'].includes(e)), ['close', 'exit 0']);
});

test('a failing database close is logged and exit still happens', async () => {
  const { lifecycle, events } = setup({ close: () => { throw new Error('locked'); } });
  await lifecycle.shutdown({ code: 0 });
  assert.ok(events.some((e) => e.startsWith('error') && e.includes('database')));
  assert.equal(events.at(-1), 'exit 0');
});

test('intervals created with every are cleared at shutdown', async () => {
  const { lifecycle, cleared } = setup();
  const fn = () => {};
  lifecycle.every(fn, 5);
  lifecycle.every(fn, 6);
  await lifecycle.shutdown({ code: 0 });
  assert.deepEqual(cleared.map((h) => h.ms), [5, 6]);
});

test('track propagates the handler result and errors, and frees its slot on failure', async () => {
  const { lifecycle, events } = setup();
  assert.equal(await lifecycle.track(async () => 7)(), 7);
  await assert.rejects(lifecycle.track(async () => { throw new Error('x'); })(), /x/);
  await lifecycle.shutdown({ code: 0 });
  assert.equal(events.some((e) => e.startsWith('sleep')), false);
});
