import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const HOUR = 3_600_000;
const T0 = BASE_TIME - 48 * HOUR;

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const msg = (id, author, content, timestamp, reference) => ({
  id,
  author,
  content,
  timestamp,
  ...(reference === undefined ? {} : { reference }),
});

const record = async (world, ...messages) => {
  for (const m of messages) await world.subject.recordMessage(m);
};

const filteredReference = (world, id) =>
  world.sqlite.get('SELECT reference FROM filtered_messages WHERE id = ?', id).reference;

test('stores every message raw in messages, including non-approved authors and filtered-out content', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', '<@111> hello there', T0 + 1, null),
    msg('m2', 'mallory', 'hello from outsider', T0 + 2, 'x9'),
    msg('m3', 'bob', 'hi', T0 + 3, null),
  );
  assert.deepEqual(world.sqlite.all('SELECT * FROM messages ORDER BY timestamp'), [
    { id: 'm1', author: 'alice', content: '<@111> hello there', timestamp: T0 + 1, reference: null },
    { id: 'm2', author: 'mallory', content: 'hello from outsider', timestamp: T0 + 2, reference: 'x9' },
    { id: 'm3', author: 'bob', content: 'hi', timestamp: T0 + 3, reference: null },
  ]);
});

test('recording the same id twice leaves one row in each table and does not throw', async (t) => {
  const world = await newWorld(t);
  const m = msg('m1', 'alice', 'hello there friends', T0, null);
  await world.subject.recordMessage(m);
  await world.subject.recordMessage(m);
  assert.equal(world.sqlite.all('SELECT id FROM messages').length, 1);
  assert.equal(world.sqlite.all('SELECT id FROM filtered_messages').length, 1);
  assert.equal(world.chroma.collection('message_embeddings').rows.size, 1);
});

test('a kept message gets a filtered_messages row with transformed content and has_gif 0', async (t) => {
  const world = await newWorld(t);
  await record(world, msg('m1', 'alice', '<@222> hello there', T0, null));
  assert.deepEqual(world.sqlite.all('SELECT * FROM filtered_messages'), [
    { id: 'm1', author: 'alice', content: '@bob hello there', timestamp: T0, reference: null, has_gif: 0 },
  ]);
});

test('a kept message containing a gif token has has_gif 1', async (t) => {
  const world = await newWorld(t);
  await record(world, msg('m1', 'alice', 'https://tenor.com/view/funny-cat-dance-gif-12345', T0, null));
  const row = world.sqlite.get('SELECT content, has_gif FROM filtered_messages WHERE id = ?', 'm1');
  assert.deepEqual(row, { content: '<gif! funny cat dance>', has_gif: 1 });
});

test('a dropped message gets no filtered_messages row, whether short or from a non-approved author', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'hi', T0, null),
    msg('m2', 'mallory', 'hello from outsider', T0 + 1, null),
  );
  assert.deepEqual(world.sqlite.all('SELECT id FROM filtered_messages'), []);
  assert.equal(world.sqlite.all('SELECT id FROM messages').length, 2);
});

test('explicit reference to a stored filtered message is kept even when a later message exists', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'carol', 'second message here', T0 + 1000, null),
    msg('m3', 'bob', 'third message here', T0 + 2000, 'm1'),
  );
  assert.equal(filteredReference(world, 'm3'), 'm1');
});

test('explicit reference to an id absent from filtered_messages falls through to the heuristic', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'bob', 'second message here', T0 + 1000, 'ghost'),
  );
  assert.equal(filteredReference(world, 'm2'), 'm1');
  assert.equal(world.sqlite.get('SELECT reference FROM messages WHERE id = ?', 'm2').reference, 'ghost');
});

test('explicit reference to a message that was filtered out falls through to the heuristic', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'carol', 'hi', T0 + 500, null),
    msg('m3', 'bob', 'third message here', T0 + 1000, 'm2'),
  );
  assert.equal(filteredReference(world, 'm3'), 'm1');
});

test('heuristic picks the latest earlier filtered message from a different author', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'carol', 'second message here', T0 + 1000, null),
    msg('m3', 'bob', 'third message here', T0 + 2000, null),
  );
  assert.equal(filteredReference(world, 'm3'), 'm2');
});

test('heuristic ignores a dropped message when finding the previous message', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'carol', 'hi', T0 + 1000, null),
    msg('m3', 'bob', 'third message here', T0 + 2000, null),
  );
  assert.equal(filteredReference(world, 'm3'), 'm1');
});

test('heuristic gives NULL when the previous message is from the same author', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'bob', 'first message here', T0, null),
    msg('m2', 'alice', 'second message here', T0 + 1000, null),
    msg('m3', 'alice', 'third message here', T0 + 2000, null),
  );
  assert.equal(filteredReference(world, 'm3'), null);
});

test('heuristic gives NULL when the previous message is exactly one hour older', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'bob', 'second message here', T0 + HOUR, null),
  );
  assert.equal(filteredReference(world, 'm2'), null);
});

test('heuristic links a previous message one millisecond under an hour older', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'bob', 'second message here', T0 + HOUR - 1, null),
  );
  assert.equal(filteredReference(world, 'm2'), 'm1');
});

test('heuristic gives NULL when there is no earlier filtered message', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'later message here', T0 + 1000, null),
    msg('m2', 'bob', 'earlier message here', T0, null),
  );
  assert.equal(filteredReference(world, 'm2'), null);
  assert.equal(filteredReference(world, 'm1'), null);
});

test('explicit reference to a stored message by the same author is kept as is', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'alice', 'second message here', T0 + 1000, 'm1'),
  );
  assert.equal(filteredReference(world, 'm2'), 'm1');
});

test('explicit reference to a stored message more than an hour older is kept as is', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'bob', 'second message here', T0 + 5 * HOUR, 'm1'),
  );
  assert.equal(filteredReference(world, 'm2'), 'm1');
});

test('recordMessage rejects when Chroma fails and keeps the rows written before the failure', async (t) => {
  const world = await newWorld(t);
  const error = new Error('chroma down');
  world.chroma.collection('message_embeddings').setFailing(error);
  await assert.rejects(world.subject.recordMessage(msg('m1', 'alice', 'hello there friends', T0, null)), error);
  assert.deepEqual(world.sqlite.all('SELECT id FROM messages'), [{ id: 'm1' }]);
  assert.deepEqual(world.sqlite.all('SELECT id, content FROM filtered_messages'), [
    { id: 'm1', content: 'hello there friends' },
  ]);
});

test('upserts a kept message into message_embeddings with transformed content and author/timestamp metadata', async (t) => {
  const world = await newWorld(t);
  await record(world, msg('m1', 'alice', '<@222> hello there', T0, null));
  const row = world.chroma.collection('message_embeddings').rows.get('m1');
  assert.equal(row.id, 'm1');
  assert.equal(row.document, '@bob hello there');
  assert.deepEqual(row.metadata, { author: 'alice', timestamp: T0 });
});

test('does not upsert a dropped message into message_embeddings', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'hi', T0, null),
    msg('m2', 'mallory', 'hello from outsider', T0 + 1, null),
  );
  assert.equal(world.chroma.collection('message_embeddings').rows.size, 0);
  assert.equal(world.chroma.collection('message_embeddings').upserts.length, 0);
});

test('KNOWN BUG (spec 10): stored metadata has no has_gif key even for a gif message', async (t) => {
  const world = await newWorld(t);
  await record(world, msg('m1', 'alice', 'https://tenor.com/view/funny-cat-dance-gif-12345', T0, null));
  const row = world.chroma.collection('message_embeddings').rows.get('m1');
  assert.equal(row.document, '<gif! funny cat dance>');
  assert.equal('has_gif' in row.metadata, false);
});

test('stores a reply under the referenced message embedding in message_reply_embeddings', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'apple banana cherry', T0, null),
    msg('m2', 'bob', 'totally different words', T0 + 1000, 'm1'),
  );
  const embeddings = world.chroma.collection('message_embeddings');
  const replies = world.chroma.collection('message_reply_embeddings');
  assert.deepEqual([...replies.rows.keys()], ['m2']);
  const row = replies.rows.get('m2');
  assert.equal(row.document, 'totally different words');
  assert.deepEqual(row.metadata, { author: 'bob', timestamp: T0 + 1000 });
  assert.deepEqual(row.embedding, embeddings.rows.get('m1').embedding);
  assert.notDeepEqual(row.embedding, embeddings.rows.get('m2').embedding);
});

test('does not store a message with an explicit reference to an unknown id in message_reply_embeddings', async (t) => {
  const world = await newWorld(t);
  await record(world, msg('m1', 'bob', 'second message here', T0, 'ghost'));
  assert.equal(world.chroma.collection('message_reply_embeddings').rows.size, 0);
  assert.equal(world.chroma.collection('message_embeddings').rows.size, 1);
});

test('KNOWN BUG (spec 10): a message with a heuristic-inferred reference is not stored in message_reply_embeddings', async (t) => {
  const world = await newWorld(t);
  await record(
    world,
    msg('m1', 'alice', 'first message here', T0, null),
    msg('m2', 'bob', 'second message here', T0 + 1000, null),
  );
  assert.equal(filteredReference(world, 'm2'), 'm1');
  assert.equal(world.chroma.collection('message_reply_embeddings').rows.size, 0);
});

test('wires Chroma on port 7429, the OpenAI embedding function and both collections', async (t) => {
  const world = await newWorld(t);
  assert.deepEqual(world.chroma.constructed, [{ port: 7429 }]);
  assert.deepEqual(world.chroma.embeddingFunctionOptions, {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    modelName: 'text-embedding-3-small',
    dimensions: 512,
  });
  assert.equal(world.chroma.collection('message_embeddings').name, 'message_embeddings');
  assert.equal(world.chroma.collection('message_reply_embeddings').name, 'message_reply_embeddings');
});
