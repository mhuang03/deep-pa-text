import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaDraw } from '../../../../src/bot/conversation/personaDraw.js';
import { loadConfig } from '../../../../src/config.js';

const NOW = 1_000_000_000_000;
const HALF_LIFE = loadConfig({}).persona.recencyHalfLifeMs;

const author = (name, share, age = 0) => ({ author: name, share, newestTimestamp: NOW - age });

const setup = ({ rolls = [], hits = [], hidden = [], fail = null, users = ['alice', 'bob', 'carol', 'dave', 'erin'] } = {}) => {
  const calls = [];
  const warnings = [];
  const used = [];
  const draw = createPersonaDraw({
    vectorStore: {
      query: async (...args) => {
        calls.push(args);
        if (fail) throw fail;
        return hits;
      },
    },
    messageStore: { hiddenIds: (ids) => new Set(ids.filter((id) => hidden.includes(id))) },
    userDirectory: { usernames: new Set(users) },
    random: () => {
      used.push(rolls[used.length] ?? 0);
      return used.at(-1);
    },
    clock: { now: () => NOW },
    config: loadConfig({}),
    logger: { warn: (...args) => warnings.push(args) },
  }).draw;
  return { draw, calls, warnings, used };
};

const hit = (id, name, distance = 0, age = 0) => ({ id, distance, metadata: { author: name, timestamp: NOW - age } });

test('draws without replacement weighted by share, one roll per draw, in the order drawn', async () => {
  const { draw, used } = setup({ rolls: [0.6, 0] });
  const candidate = { authors: [author('alice', 0.5), author('bob', 0.3), author('carol', 0.2)] };
  assert.deepEqual(await draw({ candidate, count: 2, query: 'q' }), ['bob', 'alice']);
  assert.equal(used.length, 2);
});

test('the first entry whose cumulative weight exceeds roll times total wins', async () => {
  const candidate = { authors: [author('alice', 0.5), author('bob', 0.5)] };
  assert.deepEqual(await setup({ rolls: [0.5] }).draw({ candidate, count: 1, query: 'q' }), ['bob']);
  assert.deepEqual(await setup({ rolls: [0.4999] }).draw({ candidate, count: 1, query: 'q' }), ['alice']);
});

test('an author whose last message on the topic is a half-life old weighs half as much', async () => {
  // alice 0.5 x 0.5 = 0.25 and bob 0.5 x 1 = 0.5: a roll of 0.4 (target 0.3) passes alice's 0.25 and lands on bob.
  const { draw } = setup({ rolls: [0.4] });
  const candidate = { authors: [author('alice', 0.5, HALF_LIFE), author('bob', 0.5)] };
  assert.deepEqual(await draw({ candidate, count: 1, query: 'q' }), ['bob']);
  const sameRoll = setup({ rolls: [0.3] });
  assert.deepEqual(await sameRoll.draw({ candidate, count: 1, query: 'q' }), ['alice']);
});

test('the recency discount never goes below the persona minimum', async () => {
  // Ancient alice weighs 0.5 x 0.25 = 0.125 against bob's 0.5: a roll of 0.2 (target 0.125) is past alice.
  const { draw } = setup({ rolls: [0.2] });
  const candidate = { authors: [author('alice', 0.5, 1000 * HALF_LIFE), author('bob', 0.5)] };
  assert.deepEqual(await draw({ candidate, count: 1, query: 'q' }), ['bob']);
});

test('authors who are not in the user directory are never drawn', async () => {
  const { draw } = setup({ users: ['alice', 'bob'] });
  const candidate = { authors: [author('ghost', 0.9), author('alice', 0.05), author('bob', 0.05)] };
  assert.deepEqual((await draw({ candidate, count: 2, query: 'q' })).sort(), ['alice', 'bob']);
});

test('enough authors on the topic means no history search', async () => {
  const { draw, calls } = setup();
  const candidate = { authors: [author('alice', 0.5), author('bob', 0.5)] };
  await draw({ candidate, count: 2, query: 'q' });
  assert.deepEqual(calls, []);
});

test('too few authors: tops up from a search of the history for the topic, skipping those already chosen', async () => {
  const { draw, calls } = setup({
    rolls: [0, 0, 0],
    hits: [hit('h1', 'alice'), hit('h2', 'carol'), hit('h3', 'dave', 1), hit('h4', 'ghost')],
  });
  const candidate = { authors: [author('alice', 1)] };
  const chosen = await draw({ candidate, count: 3, query: 'Weekend plans. A hike.' });
  assert.deepEqual(calls, [['messages', { text: 'Weekend plans. A hike.', limit: 60 }]]);
  assert.deepEqual(chosen, ['alice', 'carol', 'dave']);
});

test('the top-up weighs authors by similarity and recency (spec 16) with one roll per draw', async () => {
  // carol: similarity 1 (distance 0); dave: similarity 0.5 (distance 1). Weights 1 and 0.5, total 1.5.
  const hits = [hit('h1', 'carol'), hit('h2', 'dave', 1)];
  const near = setup({ rolls: [0, 0.6], hits });
  assert.deepEqual(await near.draw({ candidate: { authors: [author('alice', 1)] }, count: 2, query: 'q' }), ['alice', 'carol']);
  const far = setup({ rolls: [0, 0.7], hits });
  assert.deepEqual(await far.draw({ candidate: { authors: [author('alice', 1)] }, count: 2, query: 'q' }), ['alice', 'dave']);
});

test('hidden hits are ignored by the top-up', async () => {
  const { draw } = setup({ hits: [hit('h1', 'carol'), hit('h2', 'dave')], hidden: ['h1'] });
  assert.deepEqual(await draw({ candidate: { authors: [author('alice', 1)] }, count: 2, query: 'q' }), ['alice', 'dave']);
});

test('when the search finds nobody else the draw is simply short', async () => {
  const { draw } = setup({ hits: [] });
  assert.deepEqual(await draw({ candidate: { authors: [author('alice', 1)] }, count: 3, query: 'q' }), ['alice']);
});

test('a failed search is logged and treated as no further authors', async () => {
  const { draw, warnings } = setup({ fail: new Error('chroma down') });
  assert.deepEqual(await draw({ candidate: { authors: [author('alice', 1)] }, count: 2, query: 'q' }), ['alice']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /Could not search the history/);
});

test('a candidate with no usable authors is topped up entirely from the history', async () => {
  const { draw } = setup({ hits: [hit('h1', 'bob'), hit('h2', 'carol')] });
  assert.deepEqual((await draw({ candidate: { authors: [] }, count: 2, query: 'q' })).sort(), ['bob', 'carol']);
});
