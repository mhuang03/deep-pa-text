import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainPolicy } from '../../../src/bot/chainPolicy.js';
import { loadConfig } from '../../../src/config.js';

const make = (env = {}, roll = 0.5) => {
  const rolls = [];
  const policy = createChainPolicy({
    config: loadConfig(env), random: () => (rolls.push(roll), roll),
  });
  return { policy, rolls };
};

test('the first fullDepth bot turns are guaranteed without rolling', () => {
  const { policy, rolls } = make({}, 0.99);
  [1, 2, 3].forEach((botTurns) => assert.equal(policy.decide({ botTurns }).reply, true));
  assert.deepEqual(rolls, []);
});

test('later turns roll against a decaying chance', () => {
  const table = [[4, 0.5], [5, 0.25], [6, 0.125], [7, 0.0625]];
  table.forEach(([botTurns, chance]) => {
    const hit = make({}, chance).policy.decide({ botTurns });
    assert.deepEqual([hit.reply, hit.chance, hit.roll], [true, chance, chance]);
    const miss = make({}, chance + 0.01).policy.decide({ botTurns });
    assert.deepEqual([miss.reply, miss.chance], [false, chance]);
  });
});

test('botTurns 4 replies at roll 0.4 and not at 0.6', () => {
  assert.equal(make({}, 0.4).policy.decide({ botTurns: 4 }).reply, true);
  assert.equal(make({}, 0.6).policy.decide({ botTurns: 4 }).reply, false);
});

test('at maxBotTurns and above the chain is over and nothing rolls', () => {
  const { policy, rolls } = make({}, 0);
  [8, 9, 10].forEach((botTurns) =>
    assert.deepEqual(policy.decide({ botTurns }), { reply: false, reason: 'chain-limit' }));
  assert.deepEqual(rolls, []);
});

test('a disabled chain never replies', () => {
  const { policy } = make({ CHAIN_REPLIES: 'false' });
  assert.deepEqual(policy.decide({ botTurns: 1 }), { reply: false, reason: 'chain-disabled' });
});

test('is busy between begin and end', () => {
  const { policy } = make();
  policy.begin();
  assert.deepEqual(policy.decide({ botTurns: 1 }), { reply: false, reason: 'chain-busy' });
  policy.end();
  assert.equal(policy.decide({ botTurns: 1 }).reply, true);
});
