import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTurns, interleave } from '../../../../src/bot/conversation/turnOrder.js';
import { seededRandom } from '../../../support/topicBuilderWorld.js';

const ATTEMPTS = 50;
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];

const countsOf = (turns) => turns.reduce((map, name) => map.set(name, (map.get(name) ?? 0) + 1), new Map());
const hasAdjacentRepeat = (turns) => turns.some((name, i) => i > 0 && turns[i - 1] === name);

test('over 500 seeded runs every property holds', () => {
  for (let seed = 0; seed < 500; seed += 1) {
    const random = seededRandom(seed);
    const personaCount = 2 + Math.floor(random() * 4);
    const personas = NAMES.slice(0, personaCount);
    const count = personaCount + Math.floor(random() * (7 - personaCount));
    const turns = planTurns({ personas, count, random, attempts: ATTEMPTS });
    const context = `seed ${seed}: ${personas.length} personas, ${count} turns, ${turns.join(',')}`;
    assert.equal(turns.length, count, context);
    assert.equal(hasAdjacentRepeat(turns), false, context);
    const counts = countsOf(turns);
    personas.forEach((name) => assert.ok(counts.has(name), `${name} speaks: ${context}`));
    counts.forEach((n) => assert.ok(n <= Math.ceil(count / 2), `cap: ${context}`));
    turns.forEach((name) => assert.ok(personas.includes(name), context));
  }
});

test('two personas strictly alternate', () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const turns = planTurns({ personas: ['alice', 'bob'], count: 6, random: seededRandom(seed), attempts: ATTEMPTS });
    turns.forEach((name, i) => assert.equal(name, turns[i % 2], `seed ${seed}: ${turns.join(',')}`));
    assert.deepEqual([...countsOf(turns).values()], [3, 3]);
  }
});

test('five personas and six messages: everyone speaks and exactly one speaks twice, never consecutively', () => {
  for (let seed = 0; seed < 100; seed += 1) {
    const turns = planTurns({ personas: NAMES, count: 6, random: seededRandom(seed), attempts: ATTEMPTS });
    const counts = [...countsOf(turns).values()].sort();
    assert.deepEqual(counts, [1, 1, 1, 1, 2], `seed ${seed}`);
    assert.equal(hasAdjacentRepeat(turns), false);
  }
});

test('as many messages as personas gives each exactly one turn', () => {
  const turns = planTurns({ personas: ['alice', 'bob', 'carol'], count: 3, random: seededRandom(1), attempts: ATTEMPTS });
  assert.deepEqual([...turns].sort(), ['alice', 'bob', 'carol']);
});

const scripted = (rolls) => {
  const used = [];
  const random = () => {
    used.push(rolls[used.length] ?? 0);
    return used.at(-1);
  };
  return { random, used };
};

test('the extra turns go to uniform picks among the personas still under the cap, in the order drawn', () => {
  // 3 personas, 5 turns: cap 3, each starts with one. Roll 0.5 picks bob, roll 0 then picks alice.
  const { random } = scripted([0.5, 0]);
  const turns = planTurns({ personas: ['alice', 'bob', 'carol'], count: 5, random, attempts: ATTEMPTS });
  assert.deepEqual(Object.fromEntries(countsOf(turns)), { alice: 2, bob: 2, carol: 1 });
});

test('a persona at the cap leaves the pool: with cap 2 the second extra can only go to the other persona', () => {
  // 2 personas, 4 turns: cap 2. Both extras are forced to differ, whatever the rolls.
  const { random } = scripted([0.99, 0.99]);
  const turns = planTurns({ personas: ['alice', 'bob'], count: 4, random, attempts: ATTEMPTS });
  assert.deepEqual(Object.fromEntries(countsOf(turns)), { alice: 2, bob: 2 });
});

test('the arrangement is a weighted pick by turns left; a roll of 0 takes the first persona with turns', () => {
  const turns = planTurns({ personas: ['alice', 'bob'], count: 4, random: () => 0, attempts: ATTEMPTS });
  assert.deepEqual(turns, ['alice', 'bob', 'alice', 'bob']);
});

test('a dead end restarts the arrangement with fresh rolls, so the roll count varies', () => {
  // bob gets the extra turn (roll 0.99). Attempt 1 (rolls 0, 0) picks alice, bob and then only bob is left
  // after bob: a dead end. Attempt 2 starts with 0.99 and picks bob, alice, bob.
  const { random, used } = scripted([0.99, 0, 0, 0.99, 0, 0]);
  const turns = planTurns({ personas: ['alice', 'bob'], count: 3, random, attempts: ATTEMPTS });
  assert.deepEqual(turns, ['bob', 'alice', 'bob']);
  assert.equal(used.length, 6);
});

test('after the allowed attempts the deterministic interleave is used', () => {
  const { random, used } = scripted([0.99]);
  const turns = planTurns({ personas: ['alice', 'bob'], count: 3, random, attempts: 3 });
  assert.deepEqual(turns, ['bob', 'alice', 'bob']);
  assert.equal(used.length, 1 + 3 * 2, 'one extra-turn roll and two rolls for each failed attempt');
});

test('zero attempts go straight to the interleave', () => {
  const turns = planTurns({ personas: ['alice', 'bob', 'carol'], count: 5, random: () => 0, attempts: 0 });
  assert.equal(turns.length, 5);
  assert.equal(hasAdjacentRepeat(turns), false);
});

test('interleave puts the persona with the most turns left first and never repeats the previous speaker', () => {
  assert.deepEqual(interleave(new Map([['a', 3], ['b', 1], ['c', 1]])), ['a', 'b', 'a', 'c', 'a']);
  assert.deepEqual(interleave(new Map([['a', 2], ['b', 2]])), ['a', 'b', 'a', 'b']);
  assert.deepEqual(interleave(new Map([['a', 1], ['b', 2]])), ['b', 'a', 'b']);
});

test('interleave throws when no arrangement without a repeat exists', () => {
  assert.throws(() => interleave(new Map([['a', 3], ['b', 1]])), /twice in a row/);
});

test('planTurns rejects fewer than two personas and fewer turns than personas', () => {
  assert.throws(() => planTurns({ personas: ['a'], count: 3, random: () => 0, attempts: 1 }), /at least two personas/);
  assert.throws(() => planTurns({ personas: ['a', 'b', 'c'], count: 2, random: () => 0, attempts: 1 }), /every persona/);
});
