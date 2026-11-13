import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainBuilder } from '../../../src/context/chainBuilder.js';
import { loadConfig } from '../../../src/config.js';

const setup = ({ bots = {}, raws = {}, chain = {}, siblings = () => [], names = { bob: 'Bob', carol: 'Carol' } } = {}) => {
  const base = loadConfig({});
  const config = { ...base, chain: { ...base.chain, ...chain } };
  const builder = createChainBuilder({
    botMessageStore: { getById: (id) => bots[id] ?? null, siblings },
    messageStore: { getRaw: (id) => raws[id] ?? null },
    messageFilter: { transform: (text) => text.replace(/<[^>]*>/g, '').trim() },
    userDirectory: { nameOf: (username) => names[username] },
    config,
  });
  return builder;
};
const bot = (id, persona, content, reference = null) => ({ id, persona, content, reference });
const raw = (id, author, content, reference = null) => ({ id, author, content, reference });
const target = { id: 't', author: 'alice', content: 'why' };

test('walks upward through bot and human messages, oldest first, ending with the incoming turn', () => {
  const builder = setup({
    bots: { b2: bot('b2', 'bob', 'second', 'h1') },
    raws: { h1: raw('h1', 'alice', 'question', 'b1'), b1: raw('b1', 'x', 'unused') },
  });
  const chain = setup({
    bots: { b1: bot('b1', 'bob', 'first'), b2: bot('b2', 'bob', 'second', 'h1') },
    raws: { h1: raw('h1', 'alice', 'question', 'b1') },
  }).build(target, bot('b2', 'bob', 'second', 'h1'));
  assert.ok(builder);
  assert.equal(chain.persona, 'bob');
  assert.equal(chain.botTurns, 2);
  assert.deepEqual(chain.turns, [
    { speaker: 'bob', content: 'first', isPersona: true },
    { speaker: 'alice', content: 'question', isPersona: false },
    { speaker: 'bob', content: 'second', isPersona: true },
    { speaker: 'alice', content: 'why', isPersona: false },
  ]);
});

test('a bot message of another persona is a non-persona turn spoken by that persona', () => {
  const parent = bot('b2', 'bob', 'mine', 'b1');
  const chain = setup({ bots: { b1: bot('b1', 'carol', 'theirs') } }).build(target, parent);
  assert.deepEqual(chain.turns.slice(0, 2), [
    { speaker: 'carol', content: 'theirs', isPersona: false },
    { speaker: 'bob', content: 'mine', isPersona: true },
  ]);
  assert.equal(chain.botTurns, 2);
});

test('returns null when the persona is not in the user directory', () => {
  assert.equal(setup().build(target, bot('b', 'zed', 'x')), null);
});

test('a fallback parent ends the walk and counts as one bot turn', () => {
  const parent = { id: 'b', persona: 'bob', content: 'old', reference: null, fallback: true };
  const chain = setup().build(target, parent);
  assert.equal(chain.botTurns, 1);
  assert.deepEqual(chain.turns.map((t) => t.content), ['old', 'why']);
});

test('transforms human content, drops empty turns and continues through their reference', () => {
  const chain = setup({
    raws: { h1: raw('h1', 'alice', '<@1>', 'h0'), h0: raw('h0', 'dave', 'root <@1>') },
  }).build(target, bot('b', 'bob', 'hi', 'h1'));
  assert.deepEqual(chain.turns.map((t) => t.content), ['root', 'hi', 'why']);
});

test('stops at an unknown id or a missing reference', () => {
  const chain = setup().build(target, bot('b', 'bob', 'hi', 'gone'));
  assert.deepEqual(chain.turns.map((t) => t.content), ['hi', 'why']);
});

test('keeps only the last maxContextTurns - 1 earlier turns but counts bot turns over the whole walk', () => {
  const bots = {};
  const raws = {};
  for (let i = 1; i <= 10; i += 1) {
    bots[`b${i}`] = bot(`b${i}`, 'bob', `bot ${i}`, i > 1 ? `h${i - 1}` : null);
    if (i < 10) raws[`h${i}`] = raw(`h${i}`, 'alice', `human ${i}`, `b${i}`);
  }
  const chain = setup({ bots, raws }).build(target, bots.b10);
  assert.equal(chain.botTurns, 10);
  assert.equal(chain.turns.length, 12);
  assert.equal(chain.turns.at(-1).content, 'why');
  assert.equal(chain.turns[0].content, 'bot 5');
});

test('the walk stops after maxWalkSteps', () => {
  const raws = {};
  for (let i = 1; i <= 10; i += 1) raws[`h${i}`] = raw(`h${i}`, 'alice', `m${i}`, `h${i + 1}`);
  const chain = setup({ raws, chain: { maxWalkSteps: 3, maxContextTurns: 50 } })
    .build(target, bot('b', 'bob', 'p', 'h1'));
  assert.deepEqual(chain.turns.map((t) => t.content), ['m2', 'm1', 'p', 'why']);
});

test('a reference cycle terminates the walk', () => {
  const chain = setup({
    bots: { a: bot('a', 'bob', 'A', 'b'), b: bot('b', 'bob', 'B', 'a') },
  }).build(target, bot('a', 'bob', 'A', 'b'));
  assert.deepEqual(chain.turns.map((t) => t.content), ['B', 'A', 'why']);
  assert.equal(chain.botTurns, 2);
});

test('the incoming turn is always present even when the context is two turns', () => {
  const chain = setup({ chain: { maxContextTurns: 2 } }).build(target, bot('b', 'bob', 'p', 'h'));
  assert.deepEqual(chain.turns.map((t) => t.content), ['p', 'why']);
});

test('the parts of a burst are one assistant turn, counted once, and the walk continues from their reference', () => {
  const parts = [bot('p1', 'bob', 'one', 'h1'), bot('p2', 'bob', 'two', 'h1')];
  const chain = setup({
    raws: { h1: raw('h1', 'alice', 'question') },
    siblings: (message) => (message.id === 'p2' ? parts : []),
  }).build(target, parts[1]);
  assert.equal(chain.botTurns, 1);
  assert.deepEqual(chain.turns, [
    { speaker: 'alice', content: 'question', isPersona: false },
    { speaker: 'bob', content: 'one\ntwo', isPersona: true },
    { speaker: 'alice', content: 'why', isPersona: false },
  ]);
});

test('a fallback parent is never looked up for siblings', () => {
  let asked = false;
  const parent = { ...bot('f', 'bob', 'old'), fallback: true };
  const chain = setup({ siblings: () => { asked = true; return []; } }).build(target, parent);
  assert.equal(asked, false);
  assert.equal(chain.botTurns, 1);
});

test('a deleted human turn is skipped and the walk continues through its reference', () => {
  const parent = bot('b2', 'bob', 'second', 'h1');
  const chain = setup({
    bots: { b1: bot('b1', 'bob', 'first') },
    raws: { h1: { ...raw('h1', 'alice', 'removed text', 'b1'), deleted: true } },
  }).build(target, parent);
  assert.deepEqual(chain.turns.map((t) => t.content), ['first', 'second', 'why']);
  assert.equal(chain.botTurns, 2);
});

test('a deleted bot message as the direct parent means no chain', () => {
  const parent = { ...bot('b1', 'bob', 'gone'), deleted: true };
  assert.equal(setup().build(target, parent), null);
});

test('a deleted bot message further up ends the walk', () => {
  const parent = bot('b2', 'bob', 'second', 'h1');
  const chain = setup({
    bots: { b1: { ...bot('b1', 'bob', 'first'), deleted: true } },
    raws: { h1: raw('h1', 'alice', 'question', 'b1') },
  }).build(target, parent);
  assert.deepEqual(chain.turns.map((t) => t.content), ['question', 'second', 'why']);
  assert.equal(chain.botTurns, 1);
});

const turn = (id, persona, content, reference = null, extra = {}) => ({ id, persona, content, reference, trigger: 'conversation', ...extra });

test('a human reply to a conversation turn walks back through the earlier turns, which do not count as bot turns', () => {
  const t1 = turn('k1', 'alice', 'who is up for a hike');
  const t2 = turn('k2', 'bob', 'maybe saturday', 'k1');
  const result = setup({ bots: { k1: t1 }, names: { bob: 'Bob', alice: 'Alice' } }).build(target, t2);
  assert.equal(result.persona, 'bob');
  assert.equal(result.botTurns, 0);
  assert.deepEqual(result.turns, [
    { speaker: 'alice', content: 'who is up for a hike', isPersona: false },
    { speaker: 'bob', content: 'maybe saturday', isPersona: true },
    { speaker: 'alice', content: 'why', isPersona: false },
  ]);
});

test('ordinary bot turns still count when they follow conversation turns in the walk', () => {
  const t1 = turn('k1', 'alice', 'opener');
  const reply = { id: 'r1', persona: 'bob', content: 'chain reply', reference: 'h1', trigger: 'chain' };
  const result = setup({
    bots: { k1: t1 }, raws: { h1: raw('h1', 'carol', 'huh', 'k1') }, names: { bob: 'Bob', alice: 'Alice' },
  }).build(target, reply);
  assert.equal(result.botTurns, 1);
  assert.equal(result.turns.length, 4);
});

test('a burst conversation turn is one turn with its parts joined', () => {
  const part1 = turn('k2', 'bob', 'first part', 'k1', { timestamp: 1 });
  const part2 = turn('k3', 'bob', 'second part', 'k1', { timestamp: 2 });
  const result = setup({ siblings: () => [part1, part2], names: { bob: 'Bob' } }).build(target, part1);
  assert.equal(result.turns[0].content, 'first part\nsecond part');
  assert.equal(result.botTurns, 0);
});

test('a soft-deleted conversation turn ends the walk like any deleted bot message', () => {
  const t1 = turn('k1', 'alice', 'opener', null, { deleted: true });
  const t2 = turn('k2', 'bob', 'second', 'k1');
  const result = setup({ bots: { k1: t1 }, names: { bob: 'Bob', alice: 'Alice' } }).build(target, t2);
  assert.deepEqual(result.turns.map((t) => t.content), ['second', 'why']);
});

test('a persona override makes that persona\'s messages the model\'s own and labels the thread persona as another speaker', () => {
  const bots = { b1: bot('b1', 'carol', 'carol earlier'), b2: bot('b2', 'bob', 'bob later', 'h1') };
  const raws = { h1: raw('h1', 'alice', 'question', 'b1') };
  const chain = setup({ bots, raws }).build(target, bots.b2, { persona: 'carol' });
  assert.equal(chain.persona, 'carol');
  assert.deepEqual(chain.turns, [
    { speaker: 'carol', content: 'carol earlier', isPersona: true },
    { speaker: 'alice', content: 'question', isPersona: false },
    { speaker: 'bob', content: 'bob later', isPersona: false },
    { speaker: 'alice', content: 'why', isPersona: false },
  ]);
  assert.equal(chain.botTurns, 2);
});

test('without a target the thread ends at the parent', () => {
  const parent = bot('b', 'bob', 'what bob said');
  const chain = setup().build(null, parent, { persona: 'carol' });
  assert.deepEqual(chain.turns, [{ speaker: 'bob', content: 'what bob said', isPersona: false }]);
});

test('the override decides validity: a departed thread persona is fine, an unknown override is not', () => {
  const parent = bot('b', 'zed', 'from someone who left');
  assert.equal(setup().build(target, parent, { persona: 'carol' }).persona, 'carol');
  assert.equal(setup().build(target, bot('b', 'bob', 'x'), { persona: 'nobody' }), null);
});
