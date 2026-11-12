import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandLimiter, COMMAND_COOLDOWN_MESSAGE, COMMAND_BUSY_MESSAGE } from '../../../src/bot/commandLimiter.js';
import { loadConfig } from '../../../src/config.js';

const make = () => {
  const clock = { time: 5_000_000 };
  const limiter = createCommandLimiter({ config: loadConfig({}), now: () => clock.time });
  return { limiter, clock };
};

test('the refusal messages are the specified texts', () => {
  assert.equal(COMMAND_COOLDOWN_MESSAGE, 'You are using this too quickly. Try again in a moment.');
  assert.equal(COMMAND_BUSY_MESSAGE, 'The bot is busy with other replies. Try again in a moment.');
});

test('a fresh user is allowed and check claims nothing', () => {
  const { limiter } = make();
  for (let i = 0; i < 5; i += 1) assert.deepEqual(limiter.check('a'), { allowed: true });
});

test('the same user is refused for 29999 ms after begin and allowed at 30000 ms', () => {
  const { limiter, clock } = make();
  assert.deepEqual(limiter.begin('a'), { allowed: true });
  limiter.end();
  clock.time += 29999;
  assert.deepEqual(limiter.check('a'), { allowed: false, reason: 'cooldown' });
  clock.time += 1;
  assert.deepEqual(limiter.check('a'), { allowed: true });
});

test('another user is not affected by one user cooldown', () => {
  const { limiter } = make();
  limiter.begin('a');
  limiter.end();
  assert.deepEqual(limiter.check('b'), { allowed: true });
});

test('a third concurrent command is busy and a finished one frees a slot', () => {
  const { limiter } = make();
  assert.equal(limiter.begin('a').allowed, true);
  assert.equal(limiter.begin('b').allowed, true);
  assert.deepEqual(limiter.check('c'), { allowed: false, reason: 'busy' });
  assert.deepEqual(limiter.begin('c'), { allowed: false, reason: 'busy' });
  limiter.end();
  assert.deepEqual(limiter.begin('c'), { allowed: true });
});

test('begin re-checks and claims atomically: a second begin by one user is refused', () => {
  const { limiter } = make();
  assert.deepEqual(limiter.begin('a'), { allowed: true });
  assert.deepEqual(limiter.begin('a'), { allowed: false, reason: 'cooldown' });
  assert.deepEqual(limiter.check('c'), { allowed: true }, 'the refused begin took no slot');
});

test('cooldown is reported before busy', () => {
  const { limiter } = make();
  limiter.begin('a');
  limiter.begin('b');
  assert.equal(limiter.check('a').reason, 'cooldown');
});

test('end never drives the count below zero', () => {
  const { limiter } = make();
  limiter.end();
  limiter.end();
  limiter.begin('a');
  limiter.begin('b');
  assert.equal(limiter.begin('c').reason, 'busy');
});

test('entries older than the cooldown are dropped on every check', () => {
  const { limiter, clock } = make();
  limiter.begin('a');
  limiter.end();
  clock.time += 30000;
  assert.deepEqual(limiter.begin('a'), { allowed: true });
});

test('instances do not share state', () => {
  const first = make();
  const second = make();
  first.limiter.begin('a');
  assert.deepEqual(second.limiter.check('a'), { allowed: true });
});
