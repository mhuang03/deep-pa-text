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
  const accepted = policy.decide();
  assert.deepEqual([accepted.reply, accepted.reason, accepted.roll, accepted.chance], [true, 'accepted', 0.1, 0.1]);
  accepted.release();
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
  const decision = policy.decide();
  assert.deepEqual([decision.reply, decision.reason, typeof decision.release], [true, 'override', 'function']);
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
  const first = policy.decide();
  assert.equal(first.reply, true);
  first.release();
  policy.noteReply({ resetMisses: false });
  policy.restore({ replyTime: state.time - 1000000 });
  state.time += 299999;
  assert.equal(policy.decide().reason, 'rate-limited');
  policy.restore({ replyTime: state.time + 10 * 3600000 });
  state.time += 300001;
  assert.equal(policy.decide().reply, true, 'a future reply time is clamped to now');
});

test('an accepted roll claims the slot until release, and the claim consumes no further roll', () => {
  const { state, policy } = setup({ rolls: [0] });
  const claim = policy.decide();
  assert.equal(claim.reply, true);
  assert.equal(state.rollCount, 1);
  state.rolls = [0];
  assert.deepEqual(policy.decide(), { reply: false, reason: 'in-flight' });
  assert.equal(state.rollCount, 1);
  claim.release();
  state.rolls = [0];
  assert.equal(policy.decide().reply, true);
});

test('an in-flight decision counts no miss', () => {
  const { state, policy } = setup({ rolls: [0] });
  const claim = policy.decide();
  for (let i = 0; i < 30; i += 1) policy.decide();
  claim.release();
  state.rolls = [0.1];
  assert.equal(policy.decide().chance, 0.1);
});

test('a stale release never frees a later claim', () => {
  const { state, policy } = setup({ rolls: [0] });
  const first = policy.decide();
  first.release();
  state.rolls = [0];
  const second = policy.decide();
  assert.equal(second.reply, true);
  first.release();
  assert.equal(policy.decide().reason, 'in-flight');
  second.release();
  state.rolls = [0];
  assert.equal(policy.decide().reply, true);
});

test('override claims a slot without checking in-flight, and release is idempotent', () => {
  const { policy } = setup({ env: { REPLY_OVERRIDE: 'true' } });
  const a = policy.decide();
  const b = policy.decide();
  assert.equal(a.reply && b.reply, true);
  a.release();
  a.release();
  b.release();
  assert.equal(policy.decide().reply, true);
});

test('checks run in order: rate limit, then in-flight, then cooldown, then the roll', () => {
  const { state, policy } = setup({ rolls: [0] });
  const claim = policy.decide();
  policy.noteFailure();
  assert.equal(policy.decide().reason, 'in-flight');
  policy.noteReply({ resetMisses: false });
  assert.equal(policy.decide().reason, 'rate-limited');
  claim.release();
  state.time += 300000;
  state.rolls = [0.99];
  assert.equal(policy.decide().reason, 'random');
});

test('the cooldown is reported once nothing is in flight', () => {
  const { policy } = setup({ rolls: [0] });
  const claim = policy.decide();
  policy.noteFailure();
  claim.release();
  assert.equal(policy.decide().reason, 'cooldown');
});

test('noteFailure blocks for 59999 ms and opens at 60000 ms without a roll or a miss', () => {
  const { state, policy } = setup();
  policy.noteFailure();
  state.time += 59999;
  for (let i = 0; i < 5; i += 1) assert.deepEqual(policy.decide(), { reply: false, reason: 'cooldown' });
  assert.equal(state.rollCount, 0);
  state.time += 1;
  state.rolls = [0.1];
  const decision = policy.decide();
  assert.deepEqual([decision.reply, decision.chance], [true, 0.1]);
});

test('noteFailure does not arm the rate limit and leaves the misses alone', () => {
  const { state, policy } = setup();
  missTimes(state, policy, 12);
  policy.noteFailure();
  state.time += 60000;
  state.rolls = [0.12];
  assert.equal(policy.decide().chance, 0.1 + 2 * 0.05);
});

test('override ignores the failure cooldown', () => {
  const { policy } = setup({ env: { REPLY_OVERRIDE: 'true' } });
  policy.noteFailure();
  assert.equal(policy.decide().reply, true);
});

test('claim holds the in-flight slot: no auto reply is decided until the hold is released', () => {
  const { state, policy } = setup({ rolls: [0, 0] });
  const hold = policy.claim();
  assert.deepEqual(policy.decide(), { reply: false, reason: 'in-flight' });
  assert.equal(state.rollCount, 0, 'a held decision consumes no roll');
  hold();
  assert.equal(policy.decide().reply, true);
});

test('releasing a claim twice frees only itself, once', () => {
  const { policy } = setup({ rolls: [0] });
  const first = policy.claim();
  const second = policy.claim();
  first();
  first();
  assert.equal(policy.decide().reason, 'in-flight', 'the second claim still holds');
  second();
  assert.equal(policy.decide().reply, true);
});

test('a claim does not rate-limit by itself and an override still replies through a hold', () => {
  const { policy } = setup({ env: { REPLY_OVERRIDE: 'true' } });
  policy.claim();
  assert.equal(policy.decide().reason, 'override');
});
