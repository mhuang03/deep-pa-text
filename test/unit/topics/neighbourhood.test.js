import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNeighbourhood } from '../../../src/topics/neighbourhood.js';
import { DEFAULTS } from '../../../src/config.js';
import { buildUserDirectory } from '../../../src/userData/loadData.js';
import { USERS } from '../../support/fixtures.js';

const SETTINGS = { ...DEFAULTS.topics, minNeighbours: 3, fallbackSeeds: 2, neighbourhoodSize: 10, minMedianChars: 10, conversationSamples: 2 };
const sentence = (n) => `this is sentence number ${n} about something`;

const hit = (n, author = 'alice', extra = {}) => ({
  id: `h${n}`, document: sentence(n), metadata: { author, timestamp: 100 + n }, distance: n, ...extra,
});

const seedRow = (n) => ({ id: `s${n}`, author: 'alice', content: sentence(100 + n), timestamp: 1 });

const setup = ({ seeds = [seedRow(1), seedRow(2)], neighbourhoods = {}, embeddings = null, hidden = [], settings = {}, failQuery = false } = {}) => {
  const warnings = [];
  const calls = { queries: [], corpus: [] };
  const messageStore = {
    randomCorpus: (options) => { calls.corpus.push(options); return seeds; },
    hiddenIds: (ids) => new Set(ids.filter((id) => hidden.includes(id))),
  };
  const vectorStore = {
    getEmbeddings: async (ids) => new Map(ids.filter((id) => (embeddings ?? { s1: 1, s2: 1 })[id]).map((id) => [id, [1, 0]])),
    query: async (name, options) => {
      calls.queries.push({ name, ...options });
      if (failQuery) throw new Error('chroma down');
      return neighbourhoods[options.embedding === undefined ? '' : calls.queries.length] ?? [];
    },
  };
  const neighbourhood = createNeighbourhood({
    messageStore, vectorStore, userDirectory: buildUserDirectory(USERS), config: { topics: { ...SETTINGS, ...settings } },
    logger: { warn: (...args) => warnings.push(args) },
  });
  return { neighbourhood, warnings, calls };
};

const authorsOf = (candidate) => candidate.authors.map((a) => a.author).sort();

test('builds one candidate from the best seeded neighbourhood, with shares, newest timestamps and nearest samples', async () => {
  const small = [hit(1, 'alice'), hit(2, 'bob'), hit(3, 'alice')];
  const big = [hit(11, 'alice'), hit(12, 'bob'), hit(13, 'carol'), hit(14, 'alice')];
  const { neighbourhood, calls } = setup({ neighbourhoods: { 1: small, 2: big } });
  const [candidate] = await neighbourhood.find();
  assert.equal(candidate.topicId, null);
  assert.equal(candidate.label, null);
  assert.equal(candidate.summary, null);
  assert.deepEqual(authorsOf(candidate), ['alice', 'bob', 'carol']);
  assert.deepEqual(candidate.authors[0], { author: 'alice', share: 0.5, newestTimestamp: 114 });
  assert.deepEqual(candidate.samples, [{ author: 'alice', text: sentence(11) }, { author: 'bob', text: sentence(12) }]);
  assert.deepEqual(calls.queries.map((q) => [q.name, q.limit]), [['messages', 10], ['messages', 10]]);
  assert.equal(calls.queries[0].where, undefined);
});

test('seeds come from the random corpus, eligible rows only, at most fallbackSeeds of them', async () => {
  const seeds = [{ id: 's0', author: 'alice', content: 'yeah lol', timestamp: 1 }, seedRow(1), seedRow(2), seedRow(3)];
  const { neighbourhood, calls } = setup({ seeds, embeddings: { s0: 1, s1: 1, s2: 1, s3: 1 } });
  await neighbourhood.find();
  assert.equal(calls.corpus[0].limit, 2 * 4);
  assert.equal(calls.corpus[0].minChars, SETTINGS.minChars);
  assert.equal(calls.queries.length, 2);
});

test('a seed without a stored embedding is skipped', async () => {
  const { neighbourhood, calls } = setup({ embeddings: { s2: 1 }, neighbourhoods: { 1: [hit(1, 'alice'), hit(2, 'bob'), hit(3, 'carol')] } });
  const found = await neighbourhood.find();
  assert.equal(calls.queries.length, 1);
  assert.equal(found.length, 1);
});

test('hits hidden in SQLite, ineligible documents and authors outside the directory are dropped', async () => {
  const hits = [
    hit(1, 'alice'), hit(2, 'bob'), hit(3, 'carol'), hit(4, 'mallory'), hit(5, 'dave', { document: 'yeah lol' }), hit(6, 'dave'),
  ];
  const { neighbourhood } = setup({ hidden: ['h6'], neighbourhoods: { 1: hits } });
  const [candidate] = await neighbourhood.find();
  assert.deepEqual(candidate.samples.length, 2);
  assert.deepEqual(authorsOf(candidate), ['alice', 'bob', 'carol']);
});

test('hits with the same normalised text count once, so minNeighbours counts distinct keys', async () => {
  const dupes = [hit(1, 'alice'), hit(2, 'bob', { document: sentence(1).toUpperCase() }), hit(3, 'carol', { document: `${sentence(1)}!` }), hit(4, 'dave', { document: sentence(4) })];
  const { neighbourhood } = setup({ neighbourhoods: { 1: dupes, 2: dupes } });
  assert.deepEqual(await neighbourhood.find(), []);
  const { neighbourhood: lenient } = setup({ neighbourhoods: { 1: dupes }, settings: { minNeighbours: 2 } });
  const [candidate] = await lenient.find();
  assert.equal(candidate.samples.length, 2);
});

test('a neighbourhood needs minNeighbours hits, two authors and the median length', async () => {
  const two = [hit(1, 'alice'), hit(2, 'bob')];
  assert.deepEqual(await setup({ neighbourhoods: { 1: two, 2: two } }).neighbourhood.find(), []);
  const oneAuthor = [hit(1), hit(2), hit(3), hit(4)];
  assert.deepEqual(await setup({ neighbourhoods: { 1: oneAuthor, 2: oneAuthor } }).neighbourhood.find(), []);
  const mixed = [hit(1, 'alice'), hit(2, 'bob'), hit(3, 'carol')];
  assert.deepEqual(await setup({ neighbourhoods: { 1: mixed }, settings: { minMedianChars: 500 } }).neighbourhood.find(), []);
  assert.equal((await setup({ neighbourhoods: { 1: mixed } }).neighbourhood.find()).length, 1);
});

test('unrelated one-off messages give no candidate', async () => {
  assert.deepEqual(await setup().neighbourhood.find(), []);
});

test('a vector-store failure is logged and gives no candidate', async () => {
  const { neighbourhood, warnings } = setup({ failQuery: true });
  assert.deepEqual(await neighbourhood.find(), []);
  assert.equal(warnings.length, 1);
});
