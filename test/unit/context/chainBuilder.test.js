import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainBuilder } from '../../../src/context/chainBuilder.js';
import { loadConfig } from '../../../src/config.js';

const setup = ({ bots = {}, raws = {}, chain = {}, names = { bob: 'Bob', carol: 'Carol' } } = {}) => {
  const base = loadConfig({});
  const config = { ...base, chain: { ...base.chain, ...chain } };
  const builder = createChainBuilder({
    botMessageStore: { getById: (id) => bots[id] ?? null },
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
