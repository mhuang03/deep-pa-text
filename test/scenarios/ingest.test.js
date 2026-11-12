import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const T0 = BASE_TIME - 48 * 3_600_000;
const FILLER_COUNT = 20;

const newWorld = async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  return world;
};

const msg = (id, author, content, timestamp) => ({ id, author, content, timestamp, reference: null });

test('an inferred reply feeds persona selection for a later similar message', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    msg('m1', 'alice', 'apple banana cherry', T0),
    msg('m2', 'bob', 'totally different words', T0 + 1000),
  ]);
  const authors = await world.subject.searchLikelyRepliers(
    msg('q', 'carol', 'apple banana cherry', T0 + 5000),
  );
  assert.deepEqual(authors, ['bob']);
});

test('a live gif message by the persona appears in the gif bucket of a later retrieval', async (t) => {
  const world = await newWorld(t);
  const fillers = Array.from({ length: FILLER_COUNT }, (_, i) =>
    msg(`f${i}`, 'alice', `hello world filler${String(i).padStart(2, '0')}`, T0 + i));
  await world.seed([
    ...fillers,
    msg('g1', 'alice', 'https://tenor.com/view/funny-cat-dance-gif-12345', T0 + 100),
  ]);
  const [, , gifs] = await world.subject.semanticSearch('alice', msg('q', 'bob', 'hello world', T0 + 5000));
  assert.deepEqual(gifs, ['<gif! funny cat dance>']);
});

test('recording the same message twice makes no second Chroma call', async (t) => {
  const world = await newWorld(t);
  await world.seed([msg('m1', 'alice', 'first message here', T0)]);
  const child = msg('m2', 'bob', 'second message here', T0 + 1000);
  await world.seed([child, child]);
  assert.equal(world.chroma.collection('message_embeddings').upserts.length, 2);
  assert.equal(world.chroma.collection('message_reply_embeddings').upserts.length, 1);
});
