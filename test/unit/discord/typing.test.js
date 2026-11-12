import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTyping } from '../../../src/discord/typing.js';

const setup = ({ fail = false } = {}) => {
  const state = { calls: 0, ticks: null, cleared: [], warnings: [] };
  const channel = {
    sendTyping: async () => {
      state.calls += 1;
      if (fail) throw new Error('no permission');
    },
  };
  const clock = {
    setInterval: (fn, ms) => {
      state.ticks = { fn, ms };
      return 'h';
    },
    clearInterval: (handle) => state.cleared.push(handle),
  };
  const logger = { warn: (...args) => state.warnings.push(args) };
  const typing = startTyping(channel, { clock, refreshMs: 8000, logger });
  return { typing, state };
};

test('sends the indicator immediately and registers the refresh interval', () => {
  const { state } = setup();
  assert.equal(state.calls, 1);
  assert.equal(state.ticks.ms, 8000);
});

test('each tick sends another indicator', () => {
  const { state } = setup();
  state.ticks.fn();
  state.ticks.fn();
  assert.equal(state.calls, 3);
});

test('pulse sends one extra indicator right away', () => {
  const { typing, state } = setup();
  typing.pulse();
  assert.equal(state.calls, 2);
});

test('stop clears the interval once, is idempotent, and ends further indicators', () => {
  const { typing, state } = setup();
  typing.stop();
  typing.stop();
  assert.deepEqual(state.cleared, ['h']);
  typing.pulse();
  state.ticks.fn();
  assert.equal(state.calls, 1);
});

test('a rejected sendTyping is warned about only the first time', async () => {
  const { typing, state } = setup({ fail: true });
  typing.pulse();
  typing.pulse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls, 3);
  assert.equal(state.warnings.length, 1);
});
