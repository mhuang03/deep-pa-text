import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const T0 = BASE_TIME - 48 * 3_600_000;
const QUERY_TIME = T0 + 1_000_000;

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const msg = (id, author, content, timestamp) => ({ id, author, content, timestamp, reference: null });

// Seeds messages with strictly increasing timestamps below QUERY_TIME.
const seedAll = (world, author, contents, prefix = 's') =>
  world.seed(contents.map((content, i) => msg(`${prefix}${i}`, author, content, T0 + 1000 + i * 10)));

const embeddings = (world) => world.chroma.collection('message_embeddings');
const replyEmbeddings = (world) => world.chroma.collection('message_reply_embeddings');

const meta = (author, timestamp, extra = {}) => ({ author, timestamp, ...extra });

// Leaves rows in SQLite only, so they can reach the "other" bucket but no Chroma bucket.
const forgetInChroma = (world) => embeddings(world).rows.clear();

const query = (author, content) => msg('q', author, content, QUERY_TIME);

const sorted = (xs) => [...xs].sort();

// Chroma-only rows that all outrank unrelated rows for the query 'hello world'. There are
// enough of them (limit x over-fetch factor) to fill the over-fetched similar query completely.
const FILLER_COUNT = 60;
const assertAreFillers = (similar, fillers) => {
  assert.equal(similar.length, 20);
  similar.forEach((text) => assert.ok(fillers.includes(text), text));
};
const seedFillers = (world, author = 'alice') => {
  const contents = Array.from({ length: FILLER_COUNT }, (_, i) => `hello world filler${String(i).padStart(2, '0')}`);
  embeddings(world).seed(
    contents.map((document, i) => ({ id: `f${i}`, document, metadata: meta(author, T0 + i) })),
  );
  return contents;
};

test('semanticSearch resolves to reply, similar, gif and other buckets in that order', async (t) => {
  const world = await newWorld(t);
  const fillers = seedFillers(world);
  await seedAll(world, 'alice', ['purple cow song', 'orange tree story'], 'u');
  embeddings(world).seed([
    { id: 'u0', document: 'purple cow song', metadata: meta('alice', T0 + 1000, { has_gif: true }) },
  ]);
  replyEmbeddings(world).seed([{ id: 'r1', document: 'reply bucket text', metadata: meta('alice', T0) }]);

  const [reply, similar, gif, other] = await world.subject.semanticSearch('alice', query('alice', 'hello world'));
  assert.deepEqual(reply, ['reply bucket text']);
  assertAreFillers(similar, fillers);
  assert.deepEqual(gif, ['purple cow song']);
  assert.deepEqual(other, ['orange tree story']);
});

for (const [label, clearChroma] of [['Chroma buckets', false], ['the other bucket', true]]) {
  test(`semanticSearch ${label} contain only the author's strictly earlier messages`, async (t) => {
    const world = await newWorld(t);
    await world.seed([
      msg('a1', 'alice', 'alice earlier message', T0),
      msg('b1', 'bob', 'bob earlier message', T0 + 10),
      msg('a2', 'alice', 'alice later message', QUERY_TIME + 10),
      msg('a3', 'alice', 'alice same time message', QUERY_TIME),
    ]);
    replyEmbeddings(world).seed([
      { id: 'r1', document: 'alice reply earlier', metadata: meta('alice', T0) },
      { id: 'r2', document: 'bob reply earlier', metadata: meta('bob', T0) },
      { id: 'r3', document: 'alice reply later', metadata: meta('alice', QUERY_TIME + 5) },
      { id: 'r4', document: 'alice reply same time', metadata: meta('alice', QUERY_TIME) },
    ]);
    embeddings(world).seed(
      ['a1', 'b1', 'a2', 'a3'].map((id) => ({
        id,
        document: embeddings(world).rows.get(id).document,
        metadata: { ...embeddings(world).rows.get(id).metadata, has_gif: true },
      })),
    );
    if (clearChroma) forgetInChroma(world);

    const buckets = await world.subject.semanticSearch('alice', query('alice', 'alice message'));
    const flat = buckets.flat();
    assert.deepEqual(sorted(flat), ['alice earlier message', 'alice reply earlier']);
    if (clearChroma) assert.deepEqual(buckets[3], ['alice earlier message']);
  });
}

test('semanticSearch queries the collections with the documented limits and filters', async (t) => {
  const world = await newWorld(t);
  await world.subject.semanticSearch('alice', query('alice', 'hello world'));
  const [similar, gif] = embeddings(world).queries;
  const [reply] = replyEmbeddings(world).queries;
  assert.equal(embeddings(world).queries.length, 2);
  assert.equal(replyEmbeddings(world).queries.length, 1);
  assert.equal(reply.nResults, 30);
  assert.equal(similar.nResults, 60);
  assert.equal(gif.nResults, 30);
  assert.ok(gif.where.$and.some((clause) => clause.has_gif === true));
  assert.ok(!similar.where.$and.some((clause) => 'has_gif' in clause));
});

test('semanticSearch limits the similar bucket to the 20 nearest rows', async (t) => {
  const world = await newWorld(t);
  const fillers = seedFillers(world);
  embeddings(world).seed([{ id: 'far', document: 'unrelated words', metadata: meta('alice', T0) }]);
  const [, similar] = await world.subject.semanticSearch('alice', query('alice', 'hello world'));
  assertAreFillers(similar, fillers);
});

test('semanticSearch limits the other bucket to 10 rows', async (t) => {
  const world = await newWorld(t);
  const contents = Array.from({ length: 25 }, (_, i) => `plain message number ${i}`);
  await seedAll(world, 'alice', contents);
  forgetInChroma(world);
  const [, , , other] = await world.subject.semanticSearch('alice', query('alice', 'anything'));
  assert.equal(other.length, 10);
  assert.equal(new Set(other).size, 10);
  other.forEach((c) => assert.ok(contents.includes(c)));
});

test('semanticSearch orders the similar bucket nearest first', async (t) => {
  const world = await newWorld(t);
  await seedAll(world, 'alice', [
    'zebra',
    'apple banana',
    'apple',
    'apple banana cherry delta',
    'apple banana cherry',
  ]);
  const [, similar] = await world.subject.semanticSearch('alice', query('alice', 'apple banana cherry delta eagle'));
  assert.deepEqual(similar, [
    'apple banana cherry delta',
    'apple banana cherry',
    'apple banana',
    'apple',
    'zebra',
  ]);
});

test('semanticSearch gif bucket only contains records with has_gif true', async (t) => {
  const world = await newWorld(t);
  const fillers = seedFillers(world);
  await seedAll(world, 'alice', ['cat dance clip', 'plain unrelated words', 'second gif clip']);
  embeddings(world).seed([
    { id: 's0', document: 'cat dance clip', metadata: meta('alice', T0 + 1000, { has_gif: true }) },
    { id: 's2', document: 'second gif clip', metadata: meta('alice', T0 + 1020, { has_gif: true }) },
  ]);
  const [, similar, gif] = await world.subject.semanticSearch('alice', query('alice', 'hello world'));
  assertAreFillers(similar, fillers);
  assert.deepEqual(sorted(gif), ['cat dance clip', 'second gif clip']);
});

test('semanticSearch keeps duplicate content only in the reply bucket when it is in all buckets', async (t) => {
  const world = await newWorld(t);
  await seedAll(world, 'alice', ['shared content line']);
  embeddings(world).seed([
    { id: 's0', document: 'shared content line', metadata: meta('alice', T0 + 1000, { has_gif: true }) },
  ]);
  replyEmbeddings(world).seed([{ id: 'r1', document: 'shared content line', metadata: meta('alice', T0) }]);
  const buckets = await world.subject.semanticSearch('alice', query('alice', 'shared content line'));
  assert.deepEqual(buckets, [['shared content line'], [], [], []]);
});

test('semanticSearch keeps duplicate content only in the similar bucket over gif and other', async (t) => {
  const world = await newWorld(t);
  await seedAll(world, 'alice', ['shared content line']);
  embeddings(world).seed([
    { id: 's0', document: 'shared content line', metadata: meta('alice', T0 + 1000, { has_gif: true }) },
  ]);
  const buckets = await world.subject.semanticSearch('alice', query('alice', 'shared content line'));
  assert.deepEqual(buckets, [[], ['shared content line'], [], []]);
});

test('semanticSearch keeps duplicate content only in the gif bucket over other', async (t) => {
  const world = await newWorld(t);
  seedFillers(world);
  await seedAll(world, 'alice', ['cat dance clip']);
  embeddings(world).seed([
    { id: 's0', document: 'cat dance clip', metadata: meta('alice', T0 + 1000, { has_gif: true }) },
  ]);
  const [, , gif, other] = await world.subject.semanticSearch('alice', query('alice', 'hello world'));
  assert.deepEqual(gif, ['cat dance clip']);
  assert.deepEqual(other, []);
});

test('semanticSearch lists identical content once within the similar and other buckets', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    msg('d1', 'alice', 'same words again', T0 + 10),
    msg('d2', 'alice', 'same words again', T0 + 20),
    msg('d3', 'alice', 'other repeated text', T0 + 30),
    msg('d4', 'alice', 'other repeated text', T0 + 40),
  ]);
  embeddings(world).rows.delete('d3');
  embeddings(world).rows.delete('d4');
  const [, similar, , other] = await world.subject.semanticSearch('alice', query('alice', 'same words again'));
  assert.deepEqual(similar, ['same words again']);
  assert.deepEqual(other, ['other repeated text']);
});

test('semanticSearch other bucket holds every earlier row not in a previous bucket when under 10 candidates', async (t) => {
  const world = await newWorld(t);
  const contents = ['first plain line', 'second plain line', 'third plain line', 'fourth plain line', 'fifth plain line'];
  await seedAll(world, 'alice', contents);
  embeddings(world).rows.delete('s3');
  embeddings(world).rows.delete('s4');
  const [, similar, , other] = await world.subject.semanticSearch('alice', query('alice', 'anything at all'));
  assert.deepEqual(sorted(similar), sorted(contents.slice(0, 3)));
  assert.deepEqual(sorted(other), sorted(contents.slice(3)));
});

test('randomSearch returns exactly 50 distinct seeded contents from 60 messages', async (t) => {
  const world = await newWorld(t);
  const contents = Array.from({ length: 60 }, (_, i) => `random message number ${i}`);
  await seedAll(world, 'alice', contents);
  const result = await world.subject.randomSearch('alice');
  assert.equal(result.length, 50);
  assert.equal(new Set(result).size, 50);
  result.forEach((c) => assert.ok(contents.includes(c)));
});

test('randomSearch returns all messages when fewer than 50 exist and only from the author', async (t) => {
  const world = await newWorld(t);
  const contents = ['alice line one', 'alice line two', 'alice line three'];
  await seedAll(world, 'alice', contents);
  await seedAll(world, 'bob', ['bob line one here', 'bob line two here'], 'b');
  const result = await world.subject.randomSearch('alice');
  assert.deepEqual(sorted(result), sorted(contents));
});

test('randomSearch returns an empty list for an author without messages', async (t) => {
  const world = await newWorld(t);
  assert.deepEqual(await world.subject.randomSearch('carol'), []);
});

test('searchLikelyRepliers returns reply authors nearest first with duplicates, excluding the sender and later rows', async (t) => {
  const world = await newWorld(t);
  replyEmbeddings(world).seed([
    { id: 'r1', document: 'apple banana cherry', metadata: meta('bob', T0) },
    { id: 'r2', document: 'apple banana', metadata: meta('carol', T0) },
    { id: 'r3', document: 'apple banana cherry zebra', metadata: meta('bob', T0) },
    { id: 'r4', document: 'apple', metadata: meta('dave', T0) },
    { id: 'r5', document: 'apple banana cherry', metadata: meta('alice', T0) },
    { id: 'r6', document: 'apple banana cherry', metadata: meta('carol', QUERY_TIME + 1) },
    { id: 'r7', document: 'apple banana cherry', metadata: meta('dave', QUERY_TIME) },
  ]);
  const authors = await world.subject.searchLikelyRepliers(query('alice', 'apple banana cherry'));
  assert.deepEqual(authors, ['bob', 'bob', 'carol', 'dave']);
});

test('searchLikelyRepliers returns at most 20 authors', async (t) => {
  const world = await newWorld(t);
  replyEmbeddings(world).seed(
    Array.from({ length: 25 }, (_, i) => ({
      id: `r${i}`,
      document: `reply text ${i}`,
      metadata: meta('bob', T0 + i),
    })),
  );
  const authors = await world.subject.searchLikelyRepliers(query('alice', 'reply text'));
  assert.equal(authors.length, 20);
  assert.equal(replyEmbeddings(world).queries[0].nResults, 20);
});

test('searchLikelyRepliers returns an empty list when the collection is empty', async (t) => {
  const world = await newWorld(t);
  assert.deepEqual(await world.subject.searchLikelyRepliers(query('alice', 'anything')), []);
});
