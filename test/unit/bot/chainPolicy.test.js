import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainPolicy } from '../../../src/bot/chainPolicy.js';
import { loadConfig } from '../../../src/config.js';

const USER = 'user-a';

const make = (env = {}, roll = 0.5) => {
  const rolls = [];
  const clock = { time: 1_000_000 };
  const policy = createChainPolicy({
    config: loadConfig(env), random: () => (rolls.push(roll), roll), now: () => clock.time,
  });
  return { policy, rolls, clock };
};

// Accepts and begins one chain reply for a user, then ends it.
const accept = (policy, userId, botTurns = 1) => {
  assert.equal(policy.decide({ botTurns, userId }).reply, true);
  policy.begin({ userId });
  policy.end();
};

test('the first fullDepth bot turns are guaranteed without rolling', () => {
  const { policy, rolls } = make({}, 0.99);
  [1, 2, 3].forEach((botTurns) => assert.equal(policy.decide({ botTurns, userId: USER }).reply, true));
  assert.deepEqual(rolls, []);
});

test('later turns roll against a decaying chance', () => {
  const table = [[4, 0.5], [5, 0.25], [6, 0.125], [7, 0.0625]];
  table.forEach(([botTurns, chance]) => {
    const hit = make({}, chance).policy.decide({ botTurns, userId: USER });
    assert.deepEqual([hit.reply, hit.chance, hit.roll], [true, chance, chance]);
    const miss = make({}, chance + 0.01).policy.decide({ botTurns, userId: USER });
    assert.deepEqual([miss.reply, miss.chance], [false, chance]);
  });
});

test('botTurns 4 replies at roll 0.4 and not at 0.6', () => {
  assert.equal(make({}, 0.4).policy.decide({ botTurns: 4, userId: USER }).reply, true);
  assert.equal(make({}, 0.6).policy.decide({ botTurns: 4, userId: USER }).reply, false);
});

test('at maxBotTurns and above the chain is over and nothing rolls', () => {
  const { policy, rolls } = make({}, 0);
  [8, 9, 10].forEach((botTurns) =>
    assert.deepEqual(policy.decide({ botTurns, userId: USER }), { reply: false, reason: 'chain-limit' }));
  assert.deepEqual(rolls, []);
});

test('is busy between begin and end', () => {
  const { policy } = make();
  policy.begin({ userId: 'someone-else' });
  assert.deepEqual(policy.decide({ botTurns: 1, userId: USER }), { reply: false, reason: 'chain-busy' });
  policy.end();
  assert.equal(policy.decide({ botTurns: 1, userId: USER }).reply, true);
});

test('the same user is refused for 9999 ms and accepted again at 10000 ms', () => {
  const { policy, clock } = make();
  accept(policy, USER);
  clock.time += 9999;
  assert.deepEqual(policy.decide({ botTurns: 1, userId: USER }), { reply: false, reason: 'chain-user-cooldown' });
  clock.time += 1;
  assert.equal(policy.decide({ botTurns: 1, userId: USER }).reply, true);
});

test('another user is answered while one user is cooling down', () => {
  const { policy } = make();
  accept(policy, USER);
  assert.equal(policy.decide({ botTurns: 1, userId: 'user-b' }).reply, true);
});

test('a decision that is never begun records nothing', () => {
  const { policy } = make();
  for (let i = 0; i < 20; i += 1) assert.equal(policy.decide({ botTurns: 1, userId: USER }).reply, true);
});

test('the seventh chain reply inside the window is throttled and the window slides', () => {
  const { policy, clock } = make();
  for (let i = 0; i < 6; i += 1) {
    accept(policy, `user-${i}`);
    clock.time += 1000;
  }
  assert.deepEqual(policy.decide({ botTurns: 1, userId: 'fresh' }), { reply: false, reason: 'chain-throttled' });
  // The first acceptance happened 6 s ago; it leaves the window at 600000 ms.
  clock.time += 600000 - 6000;
  assert.equal(policy.decide({ botTurns: 1, userId: 'fresh' }).reply, true);
});

test('the limits come before the depth rules and nothing rolls while limited', () => {
  const { policy, rolls } = make({}, 0);
  accept(policy, USER);
  assert.equal(policy.decide({ botTurns: 8, userId: USER }).reason, 'chain-user-cooldown');
  assert.deepEqual(rolls, []);
});

test('busy is checked before the limits', () => {
  const { policy } = make();
  accept(policy, USER);
  policy.begin({ userId: 'other' });
  assert.equal(policy.decide({ botTurns: 1, userId: USER }).reason, 'chain-busy');
});

test('a zero cooldown never refuses a user', () => {
  const zero = createChainPolicy({
    config: { chain: { ...loadConfig({}).chain, userCooldownMs: 0 } }, random: () => 0.5, now: () => 5,
  });
  accept(zero, USER);
  assert.equal(zero.decide({ botTurns: 1, userId: USER }).reply, true);
});
