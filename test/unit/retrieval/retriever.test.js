import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createVectorStore } from '../../../src/storage/vectorStore.js';
import { createRetriever, BUCKET_ORDER } from '../../../src/retrieval/retriever.js';
import { createFakeChroma } from '../../support/fakes/chroma.js';

const baseConfig = {
  storage: { inferredReferenceWindowMs: 3600000 },
  chroma: { messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings' },
  retrieval: { replyResults: 2, similarResults: 3, gifResults: 2, otherResults: 4, reviveSamples: 5 },
};

const setup = async ({ replyResults = 2 } = {}) => {
  const config = { ...baseConfig, retrieval: { ...baseConfig.retrieval, replyResults } };
  const fake = createFakeChroma();
  const embeddingFunction = new fake.OpenAIEmbeddingFunction({});
  const generate = embeddingFunction.generate.bind(embeddingFunction);
  const embedCalls = [];
  embeddingFunction.generate = (texts) => {
    embedCalls.push(texts);
    return generate(texts);
  };
  const client = new fake.ChromaClient({});
  const vectorStore = createVectorStore({ client, embeddingFunction, config });
  await vectorStore.connect();
  const db = openDatabase(':memory:');
  const messageStore = createMessageStore({ db, config });
  const retriever = createRetriever({ vectorStore, messageStore, config });
  return { fake, retriever, messageStore, embedCalls };
};

const seed = (ctx, collection, rows) => {
  ctx.fake.state.collection(collection).seed(rows.map(([id, document, metadata]) => ({ id, document, metadata })));
};
const meta = (author, timestamp, extra = {}) => ({ author, timestamp, ...extra });
const store = (ctx, id, author, content, timestamp) => {
  ctx.messageStore.insertFiltered({ id, author, content, timestamp, reference: null });
};
const record = { author: 'bob', content: 'cats rule', timestamp: 100 };

test('BUCKET_ORDER is replies, similar, gifs, other', () => {
  assert.deepEqual(BUCKET_ORDER, ['replies', 'similar', 'gifs', 'other']);
});

test('embeds the message once and shares it across the three queries', async () => {
  const ctx = await setup();
  await ctx.retriever.retrieveForReply('alice', record);
  assert.deepEqual(ctx.embedCalls, [['cats rule']]);
  const [q1] = ctx.fake.state.collection('message_embeddings').queries;
  const [q2, q3] = [ctx.fake.state.collection('message_reply_embeddings').queries[0],
    ctx.fake.state.collection('message_embeddings').queries[1]];
  assert.deepEqual(q1.queryEmbeddings, q2.queryEmbeddings);
  assert.deepEqual(q1.queryEmbeddings, q3.queryEmbeddings);
});

test('uses the configured limits and the legacy where shapes', async () => {
  const ctx = await setup();
  await ctx.retriever.retrieveForReply('alice', record);
  const [similar, gif] = ctx.fake.state.collection('message_embeddings').queries;
  const [reply] = ctx.fake.state.collection('message_reply_embeddings').queries;
  const base = [{ author: 'alice' }, { timestamp: { $lt: 100 } }];
  assert.equal(similar.nResults, 3);
  assert.equal(reply.nResults, 2);
  assert.equal(gif.nResults, 2);
  assert.deepEqual(similar.where, { $and: base });
  assert.deepEqual(reply.where, { $and: base });
  assert.deepEqual(gif.where, { $and: [...base, { has_gif: true }] });
});

test('restricts every bucket to the author and strictly earlier messages', async () => {
  const ctx = await setup();
  const rows = [
    ['a1', 'cats early', meta('alice', 50, { has_gif: true })],
    ['a2', 'cats same time', meta('alice', 100, { has_gif: true })],
    ['a3', 'cats later', meta('alice', 150, { has_gif: true })],
    ['b1', 'cats other author', meta('bob', 50, { has_gif: true })],
  ];
  seed(ctx, 'message_embeddings', rows);
  seed(ctx, 'message_reply_embeddings', rows);
  store(ctx, 's1', 'alice', 'cats early', 50);
  store(ctx, 's2', 'alice', 'cats same time', 100);
  store(ctx, 's3', 'bob', 'cats other author', 50);
  const buckets = await ctx.retriever.retrieveForReply('alice', record);
  assert.deepEqual(buckets, { replies: [{ you: 'cats early', them: null }], similar: [], gifs: [], other: [] });
});

test('similar is nearest first and the gif bucket only holds has_gif messages', async () => {
  const ctx = await setup();
  seed(ctx, 'message_embeddings', [
    ['1', 'cats rule', meta('alice', 1, { has_gif: false })],
    ['2', 'cats', meta('alice', 2, { has_gif: false })],
    ['3', 'rule', meta('alice', 3, { has_gif: false })],
    ['4', 'cats rule rule', meta('alice', 4, { has_gif: false })],
    ['5', 'zebra quartz yodel', meta('alice', 5, { has_gif: true })],
  ]);
  const buckets = await ctx.retriever.retrieveForReply('alice', record);
  assert.equal(buckets.similar[0], 'cats rule');
  assert.equal(buckets.similar.length, 3);
  assert.ok(!buckets.similar.includes('zebra quartz yodel'));
  assert.deepEqual(buckets.gifs, ['zebra quartz yodel']);
});

test('dedupes across buckets with reply > similar > gifs > other', async () => {
  const ctx = await setup();
  const dup = ['d1', 'same text', meta('alice', 1, { has_gif: true })];
  seed(ctx, 'message_embeddings', [dup, ['d2', 'only similar', meta('alice', 2, { has_gif: false })]]);
  seed(ctx, 'message_reply_embeddings', [dup]);
  store(ctx, 'x1', 'alice', 'same text', 1);
  store(ctx, 'x2', 'alice', 'only random', 3);
  const buckets = await ctx.retriever.retrieveForReply('alice', record);
  assert.deepEqual(buckets.replies, [{ you: 'same text', them: null }]);
  assert.deepEqual(buckets.similar, ['only similar']);
  assert.deepEqual(buckets.gifs, []);
  assert.deepEqual(buckets.other, ['only random']);
});

test('the other bucket is limited and time restricted', async () => {
  const ctx = await setup();
  for (let i = 0; i < 10; i += 1) store(ctx, `s${i}`, 'alice', `msg ${i}`, i);
  store(ctx, 'late', 'alice', 'msg late', 500);
  const { other } = await ctx.retriever.retrieveForReply('alice', record);
  assert.equal(other.length, 4);
  assert.ok(!other.includes('msg late'));
});

test('retrieveForRevive returns up to reviveSamples contents of the author', async () => {
  const ctx = await setup();
  for (let i = 0; i < 8; i += 1) store(ctx, `a${i}`, 'alice', `msg ${i}`, i);
  store(ctx, 'b', 'bob', 'bob msg', 99);
  const out = await ctx.retriever.retrieveForRevive('alice');
  assert.equal(out.length, 5);
  assert.ok(out.every((c) => c.startsWith('msg ')));
  assert.deepEqual(await ctx.retriever.retrieveForRevive('bob'), ['bob msg']);
});

test('retrieveForReply embeds queryText when given, else the record content', async () => {
  const ctx = await setup();
  await ctx.retriever.retrieveForReply('alice', record, { queryText: 'line one\ncats rule' });
  await ctx.retriever.retrieveForReply('alice', record);
  assert.deepEqual(ctx.embedCalls.map(([text]) => text), ['line one\ncats rule', 'cats rule']);
});

test('reply examples pair each hit with the content of its parent message', async () => {
  const ctx = await setup({ replyResults: 5 });
  store(ctx, 'p1', 'bob', 'anyone up for food', 10);
  ctx.messageStore.insertFiltered({ id: 'r1', author: 'alice', content: 'im down, where', timestamp: 20, reference: 'p1' });
  store(ctx, 'solo', 'alice', 'no parent here', 30);
  seed(ctx, 'message_reply_embeddings', [
    ['r1', 'im down, where', meta('alice', 20)],
    ['solo', 'no parent here', meta('alice', 30)],
    ['chroma-only', 'only in chroma', meta('alice', 40)],
  ]);
  const { replies } = await ctx.retriever.retrieveForReply('alice', { ...record, timestamp: 100 });
  const byYou = Object.fromEntries(replies.map((e) => [e.you, e.them]));
  assert.equal(byYou['im down, where'], 'anyone up for food');
  assert.equal(byYou['no parent here'], null);
  assert.equal(byYou['only in chroma'], null);
});

test('hits sharing a document keep the nearest id and its parent; one getParents call', async () => {
  const ctx = await setup();
  store(ctx, 'p1', 'bob', 'first parent', 1);
  store(ctx, 'p2', 'bob', 'second parent', 2);
  ctx.messageStore.insertFiltered({ id: 'r1', author: 'alice', content: 'cats rule', timestamp: 20, reference: 'p1' });
  ctx.messageStore.insertFiltered({ id: 'r2', author: 'alice', content: 'cats rule', timestamp: 30, reference: 'p2' });
  seed(ctx, 'message_reply_embeddings', [
    ['r2', 'cats rule', meta('alice', 30)],
    ['r1', 'cats rule', meta('alice', 20)],
  ]);
  const calls = [];
  const original = ctx.messageStore.getParents;
  ctx.messageStore.getParents = (ids) => { calls.push(ids); return original(ids); };
  const { replies } = await ctx.retriever.retrieveForReply('alice', { ...record, timestamp: 100 });
  assert.equal(replies.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(replies[0].them, calls[0][0] === 'r1' ? 'first parent' : 'second parent');
});
