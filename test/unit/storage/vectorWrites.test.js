import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorWrites } from '../../../src/storage/vectorWrites.js';
import { createFakeChroma, fakeEmbed } from '../../support/fakes/chroma.js';

const guard = { timed: async (name, ms, work) => work(), limits: { interactive: 1, batch: 2, connect: 3 } };

const setup = async () => {
  const fake = createFakeChroma();
  const client = new fake.ChromaClient({});
  const embeddingFunction = new fake.OpenAIEmbeddingFunction({});
  const messages = await client.getOrCreateCollection({ name: 'm', embeddingFunction });
  const replies = await client.getOrCreateCollection({ name: 'r', embeddingFunction });
  const writes = createVectorWrites({ guard, collections: async () => ({ messages, replies }) });
  return { fake, messages, replies, writes };
};
const msg = (id, content, reference = null) => ({ id, author: 'a', content, timestamp: 10, reference, hasGif: false });

test('upsertMessages adds the messages and ignores an empty list', async () => {
  const { writes, messages, fake } = await setup();
  await writes.upsertMessages([]);
  assert.equal(messages.upserts.length, 0);
  await writes.upsertMessages([msg('1', 'one'), msg('1', 'one again'), msg('2', 'two')]);
  assert.deepEqual([...messages.rows.keys()], ['1', '2']);
  assert.equal(messages.rows.get('1').document, 'one again');
  assert.equal(fake.state.embeddingCalls, 1);
});

test('a reply row reuses the parent embedding instead of embedding the reply text', async () => {
  const { writes, messages, replies, fake } = await setup();
  await writes.upsertMessages([msg('p', 'parent text')]);
  const calls = fake.state.embeddingCalls;
  await writes.upsertMessages([msg('c', 'child text', 'p')]);
  assert.deepEqual(replies.rows.get('c').embedding, fakeEmbed('parent text'));
  assert.equal(fake.state.embeddingCalls, calls + 1);
  assert.equal(messages.rows.has('c'), true);
});

test('a reply whose parent has no embedding gets no reply row', async () => {
  const { writes, replies } = await setup();
  await writes.upsertMessages([msg('c', 'child text', 'unknown-parent')]);
  assert.equal(replies.rows.size, 0);
});

test('fillMetadata passes the stored document and embedding back unchanged', async () => {
  const { writes, messages } = await setup();
  messages.seed([{ id: '1', document: 'doc', metadata: { author: 'a', timestamp: 1 }, embedding: [9, 9] }]);
  await writes.fillMetadata('messages', [
    { id: '1', document: 'doc', embedding: [9, 9], metadata: { author: 'a', timestamp: 1, has_gif: false } },
  ]);
  assert.deepEqual(messages.rows.get('1').embedding, [9, 9]);
  assert.equal(messages.rows.get('1').metadata.has_gif, false);
  await writes.fillMetadata('messages', []);
  await assert.rejects(writes.fillMetadata('bogus', [{ id: 'x', document: 'd', embedding: [1], metadata: {} }]), /Unknown collection/);
});

test('addReplyRows writes reply rows with the given embeddings', async () => {
  const { writes, replies } = await setup();
  await writes.addReplyRows([]);
  await writes.addReplyRows([{ message: msg('c', 'child', 'p'), embedding: [1, 2] }]);
  assert.deepEqual(replies.rows.get('c').embedding, [1, 2]);
});
