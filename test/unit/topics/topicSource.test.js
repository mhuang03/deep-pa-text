import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopicSource } from '../../../src/topics/topicSource.js';
import { DEFAULTS } from '../../../src/config.js';
import { buildUserDirectory } from '../../../src/userData/loadData.js';
import { USERS } from '../../support/fixtures.js';

const NOW = 1_000_000_000_000;
const DAY = 86400000;
const HALF_LIFE = DEFAULTS.topics.recencyHalfLifeMs;

const authors = (...names) => names.map((author) => ({ author, share: 1 / names.length, newestTimestamp: NOW - DAY }));
const topic = (id, overrides = {}) => ({
  id, label: `Topic ${id}`, summary: `About ${id}`, size: 10, authorCount: 2, cohesion: 0.5, medianTimestamp: NOW,
  authors: authors('alice', 'bob'), ...overrides,
});

const rolls = (values) => {
  let i = 0;
  const next = () => values[Math.min(i++, values.length - 1)];
  next.count = () => i;
  return next;
};

const setup = ({
  topics = [], samples = {}, build = null, random = rolls([0]), starters = [], settings = {}, failStarters = false, fallback = null,
} = {}) => {
  const warnings = [];
  const topicStore = {
    currentTopics: () => topics,
    currentBuild: () => build,
    samplesOf: (id, limit) => (samples[id] ?? [{ author: 'alice', text: `sample of ${id}` }]).slice(0, limit),
  };
  const messageStore = {
    randomStartersAll: (options) => {
      if (failStarters) throw new Error('db locked');
      messageStore.lastStarters = options;
      return starters;
    },
    randomCorpus: () => fallback?.seeds ?? [],
    hiddenIds: () => new Set(),
  };
  const vectorStore = {
    getEmbeddings: async (ids) => new Map(ids.map((id) => [id, [1, 0]])),
    query: async () => fallback?.hits ?? [],
  };
  const source = createTopicSource({
    topicStore, messageStore, vectorStore, userDirectory: buildUserDirectory(USERS), random, clock: { now: () => NOW },
    config: { ...DEFAULTS, topics: { ...DEFAULTS.topics, ...settings } }, logger: { warn: (...args) => warnings.push(args) },
  });
  return { source, warnings, messageStore, random };
};

test('returns bank topics as candidates with samples, authors and ids', async () => {
  const { source } = setup({ topics: [topic(1)] });
  const [candidate] = await source.candidates({ limit: 3 });
  assert.deepEqual(candidate, {
    topicId: 1, label: 'Topic 1', summary: 'About 1', authors: authors('alice', 'bob'),
    samples: [{ author: 'alice', text: 'sample of 1' }],
  });
});

test('draws without replacement, one roll per draw, never more than limit', async () => {
  const random = rolls([0.1, 0.1, 0.1]);
  const { source } = setup({ topics: [topic(1), topic(2), topic(3)], random });
  const found = await source.candidates({ limit: 2 });
  assert.equal(found.length, 2);
  assert.equal(new Set(found.map((c) => c.topicId)).size, 2);
  assert.equal(random.count(), 2);
  assert.equal((await setup({ topics: [topic(1)] }).source.candidates({ limit: 5 })).length, 1);
});

test('the weight is recency (floored) times log(1 + size): scripted rolls pick the heavy or the light topic', async () => {
  const fresh = topic(1, { medianTimestamp: NOW });
  const ancient = topic(2, { medianTimestamp: NOW - 50 * HALF_LIFE });
  const wFresh = Math.log(11);
  const wAncient = 0.1 * Math.log(11);
  const total = wFresh + wAncient;
  const low = await setup({ topics: [fresh, ancient], random: rolls([(wFresh * 0.99) / total]) }).source.candidates({ limit: 1 });
  assert.equal(low[0].topicId, 1);
  const high = await setup({ topics: [fresh, ancient], random: rolls([(wFresh * 1.01) / total]) }).source.candidates({ limit: 1 });
  assert.equal(high[0].topicId, 2);
});

test('a bigger topic weighs more than a smaller one of the same age', async () => {
  const small = topic(1, { size: 2 });
  const large = topic(2, { size: 100 });
  const share = Math.log(3) / (Math.log(3) + Math.log(101));
  const pickSmall = await setup({ topics: [small, large], random: rolls([share * 0.99]) }).source.candidates({ limit: 1 });
  const pickLarge = await setup({ topics: [small, large], random: rolls([share * 1.01]) }).source.candidates({ limit: 1 });
  assert.deepEqual([pickSmall[0].topicId, pickLarge[0].topicId], [1, 2]);
});

test('a topic exactly one half-life old weighs half', async () => {
  const fresh = topic(1);
  const aged = topic(2, { medianTimestamp: NOW - HALF_LIFE });
  const total = 1.5;
  const first = await setup({ topics: [fresh, aged], random: rolls([(0.99 * 1) / total]) }).source.candidates({ limit: 1 });
  const second = await setup({ topics: [fresh, aged], random: rolls([(1.01 * 1) / total]) }).source.candidates({ limit: 1 });
  assert.deepEqual([first[0].topicId, second[0].topicId], [1, 2]);
});

test('excluded topic ids are not offered', async () => {
  const { source } = setup({ topics: [topic(1), topic(2)] });
  const found = await source.candidates({ limit: 5, excludeTopicIds: [1] });
  assert.deepEqual(found.map((c) => c.topicId), [2]);
});

test('authors outside the directory are removed and a topic left with fewer than two is dropped', async () => {
  const mixed = topic(1, { authors: authors('alice', 'bob', 'mallory') });
  const lone = topic(2, { authors: authors('alice', 'mallory') });
  const { source } = setup({ topics: [mixed, lone] });
  const found = await source.candidates({ limit: 5 });
  assert.deepEqual(found.map((c) => c.topicId), [1]);
  assert.deepEqual(found[0].authors.map((a) => a.author), ['alice', 'bob']);
});

test('a topic whose samples are all gone is not offered', async () => {
  const { source } = setup({ topics: [topic(1), topic(2)], samples: { 1: [] }, random: rolls([0, 0]) });
  const found = await source.candidates({ limit: 2 });
  assert.deepEqual(found.map((c) => c.topicId), [2]);
});

test('samples are limited to conversationSamples', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ author: 'alice', text: `s${i}` }));
  const { source } = setup({ topics: [topic(1)], samples: { 1: many } });
  assert.equal((await source.candidates({ limit: 1 }))[0].samples.length, DEFAULTS.topics.conversationSamples);
});

test('falls back to a neighbourhood when every bank topic is excluded, and when fewer than two directory authors remain', async () => {
  const sentence = (n) => `this is sentence number ${n} about something`;
  const hits = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: `h${n}`, document: sentence(n), metadata: { author: n % 2 ? 'alice' : 'bob', timestamp: n }, distance: n,
  }));
  const seeds = [{ id: 's1', author: 'alice', content: sentence(99), timestamp: 1 }];
  const fallback = { seeds, hits };
  const excluded = await setup({ topics: [topic(1)], fallback }).source.candidates({ limit: 3, excludeTopicIds: [1] });
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].topicId, null);
  const stranger = topic(1, { authors: authors('mallory', 'trudy') });
  assert.equal((await setup({ topics: [stranger], fallback }).source.candidates({ limit: 3 }))[0].topicId, null);
  assert.deepEqual(await setup({ topics: [], fallback: { seeds: [], hits: [] } }).source.candidates({ limit: 3 }), []);
});

test('openers are eligible, distinct, directory authors, over-fetched and cut to the limit', () => {
  const starters = [
    { author: 'alice', content: 'Who wants to play something tonight everyone' },
    { author: 'bob', content: 'who wants to play something tonight everyone!' },
    { author: 'mallory', content: 'a message by a stranger in the channel' },
    { author: 'carol', content: 'yeah lol' },
    { author: 'dave', content: 'anyone seen the new trailer for that film' },
    { author: 'alice', content: 'one more perfectly fine opening message here' },
  ];
  const { source, messageStore } = setup({ starters });
  const found = source.openers({ limit: 2 });
  assert.deepEqual(found, [
    { author: 'alice', text: 'Who wants to play something tonight everyone' },
    { author: 'dave', text: 'anyone seen the new trailer for that film' },
  ]);
  assert.deepEqual(messageStore.lastStarters, {
    minGapMs: DEFAULTS.revive.starterGapMs, limit: 2 * DEFAULTS.retrieval.overFetchFactor,
  });
});

test('openers log a failure and return nothing', () => {
  const { source, warnings } = setup({ failStarters: true });
  assert.deepEqual(source.openers({ limit: 3 }), []);
  assert.equal(warnings.length, 1);
});

test('bankStatus reports the topic count, build time and staleness at the boundary', () => {
  const maxAge = DEFAULTS.topics.maxAgeMs;
  const empty = setup().source.bankStatus();
  assert.deepEqual(empty, { topics: 0, completedAt: null, stale: true });
  const fresh = setup({ topics: [topic(1)], build: { buildId: 'b', completedAt: NOW - maxAge } }).source.bankStatus();
  assert.deepEqual(fresh, { topics: 1, completedAt: NOW - maxAge, stale: false });
  const old = setup({ topics: [topic(1)], build: { buildId: 'b', completedAt: NOW - maxAge - 1 } }).source.bankStatus();
  assert.equal(old.stale, true);
});
