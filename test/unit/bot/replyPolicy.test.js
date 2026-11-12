import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplyPolicy } from '../../../src/bot/replyPolicy.js';
import { loadConfig } from '../../../src/config.js';

const setup = ({ rolls = [], env = {} } = {}) => {
  const state = { time: 1000000, rolls: [...rolls], rollCount: 0 };
  const random = () => {
    state.rollCount++;
    return state.rolls.length > 0 ? state.rolls.shift() : 0.99;
  };
  const policy = createReplyPolicy({ config: loadConfig(env), now: () => state.time, random });
  return { state, policy };
};

const missTimes = (state, policy, count) => {
  state.rolls = Array(count).fill(0.99);
  for (let i = 0; i < count; i++) assert.equal(policy.decide().reply, false);
};

test('accepts a roll equal to the chance and rejects a greater one', () => {
  const { policy } = setup({ rolls: [0.1, 0.11] });
  assert.deepEqual(policy.decide(), { reply: true, reason: 'accepted', roll: 0.1, chance: 0.1 });
  assert.deepEqual(policy.decide(), { reply: false, reason: 'random', roll: 0.11, chance: 0.1 });
});

test('is rate-limited for 299999 ms and open at 300000 ms', () => {
  const { state, policy } = setup({ rolls: [0] });
  policy.noteReply({ resetMisses: true });
  state.time += 299999;
  assert.deepEqual(policy.decide(), { reply: false, reason: 'rate-limited' });
  state.time += 1;
  state.rolls = [0];
  assert.equal(policy.decide().reply, true);
});

test('rate-limited decisions consume no roll and count no miss', () => {
  const { state, policy } = setup();
  policy.noteReply({ resetMisses: false });
  for (let i = 0; i < 20; i++) policy.decide();
  assert.equal(state.rollCount, 0);
  state.time += 300000;
  state.rolls = [0.1];
  assert.equal(policy.decide().chance, 0.1);
});

test('override replies without rolling and ignores the rate limit', () => {
  const { state, policy } = setup({ env: { REPLY_OVERRIDE: 'true' } });
  policy.noteReply({ resetMisses: true });
  assert.deepEqual(policy.decide(), { reply: true, reason: 'override' });
  assert.equal(state.rollCount, 0);
});

[[10, 0.1], [11, 0.1 + 1 * 0.05], [12, 0.1 + 2 * 0.05], [28, 0.1 + 18 * 0.05]].forEach(([misses, chance]) => {
  test(`chance after ${misses} misses is ${chance}`, () => {
    const { state, policy } = setup();
    missTimes(state, policy, misses);
    state.rolls = [0];
    const decision = policy.decide();
    assert.equal(decision.chance, chance);
    assert.equal(decision.reply, true);
  });
});

test('replies on the 12th message with a constant roll of 0.12', () => {
  const { state, policy } = setup();
  const results = [];
  for (let i = 0; i < 12; i++) {
    state.rolls = [0.12];
    results.push(policy.decide().reply);
  }
  assert.deepEqual(results, [...Array(11).fill(false), true]);
});

test('the chance reaches 1 so the 29th message always replies', () => {
  const { state, policy } = setup();
  missTimes(state, policy, 28);
  state.rolls = [0.99];
  assert.equal(policy.decide().reply, true);
});

test('noteReply with resetMisses true zeroes the miss counter', () => {
  const { state, policy } = setup();
  missTimes(state, policy, 12);
  policy.noteReply({ resetMisses: true });
  state.time += 300000;
  state.rolls = [0.12];
  assert.deepEqual(policy.decide(), { reply: false, reason: 'random', roll: 0.12, chance: 0.1 });
});

test('noteReply with resetMisses false keeps the miss counter but arms the rate limit', () => {
  const { state, policy } = setup();
  missTimes(state, policy, 12);
  policy.noteReply({ resetMisses: false });
  assert.equal(policy.decide().reason, 'rate-limited');
  state.time += 300000;
  state.rolls = [0.12];
  assert.equal(policy.decide().chance, 0.1 + 2 * 0.05);
});

test('instances do not share state', () => {
  const a = setup();
  const b = setup({ rolls: [0] });
  missTimes(a.state, a.policy, 3);
  assert.equal(b.policy.decide().reply, true);
});

test('restore arms the rate limit from a past reply time', () => {
  const { state, policy } = setup({ rolls: [0] });
  policy.restore({ replyTime: state.time - 120000 });
  assert.deepEqual(policy.decide(), { reply: false, reason: 'rate-limited' });
  state.time += 180001;
  assert.equal(policy.decide().reply, true);
});

test('restore ignores null, never moves the reply time backwards and clamps to now', () => {
  const { state, policy } = setup({ rolls: [0, 0] });
  policy.restore({ replyTime: null });
  assert.equal(policy.decide().reply, true);
  policy.noteReply({ resetMisses: false });
  policy.restore({ replyTime: state.time - 1000000 });
  state.time += 299999;
  assert.equal(policy.decide().reason, 'rate-limited');
  policy.restore({ replyTime: state.time + 10 * 3600000 });
  state.time += 300001;
  assert.equal(policy.decide().reply, true, 'a future reply time is clamped to now');
});
