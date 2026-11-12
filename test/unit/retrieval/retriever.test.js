import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createVectorStore } from '../../../src/storage/vectorStore.js';
import { createRetriever, BUCKET_ORDER } from '../../../src/retrieval/retriever.js';
import { createFakeChroma, fakeEmbed } from '../../support/fakes/chroma.js';

const baseConfig = {
  storage: { inferredReferenceWindowMs: 3600000 },
  chroma: { messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings' },
  retrieval: { replyResults: 2, similarResults: 3, gifResults: 2, otherResults: 4, reviveSamples: 5,
    overFetchFactor: 3, nearDuplicateThreshold: 0.95, nearDuplicateMinChars: 12,
    frequentMinCount: 3, frequentLimit: 10,
  },
};

const setup = async ({ replyResults = 2, ...overrides } = {}) => {
  const retrievalConfig = { ...baseConfig.retrieval, replyResults, ...overrides };
  const config = { ...baseConfig, retrieval: retrievalConfig };
  const warnings = [];
  const logger = { warn: (line) => warnings.push(line) };
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
  const retriever = createRetriever({ vectorStore, messageStore, config, logger });
  return { fake, retriever, messageStore, embedCalls, vectorStore, warnings };
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
  assert.equal(similar.nResults, 9);
  assert.equal(reply.nResults, 6);
  assert.equal(gif.nResults, 6);
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
  assert.deepEqual(buckets, { replies: [{ you: 'cats early', them: null }], similar: [], gifs: [], other: [], frequent: [] });
});

test('similar is nearest first and the gif bucket only holds has_gif messages', async () => {
  const ctx = await setup();
  seed(ctx, 'message_embeddings', [
    ['1', 'cats rule', meta('alice', 1, { has_gif: false })],
    ['2', 'cats', meta('alice', 2, { has_gif: false })],
    ['3', 'rule', meta('alice', 3, { has_gif: false })],
    ['4', 'cats rule rule', meta('alice', 4, { has_gif: false })],
    ['5', 'zebra quartz yodel', meta('alice', 5, { has_gif: true })],
    // Enough nearer rows to fill the over-fetched similar query (3 x 3), so the gif row stays out of it.
    ...Array.from({ length: 6 }, (_, i) => [`n${i}`, `cats rule extra${i}`, meta('alice', 10 + i, { has_gif: false })]),
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

test('a bucket still reaches its limit when near-identical nearest hits are merged away', async () => {
  const ctx = await setup();
  const rows = Array.from({ length: 7 }, (_, i) => [`v${i}`, `cats rule${'e'.repeat(i + 3)}`, meta('alice', i)]);
  rows.push(['d1', 'cats alpha', meta('alice', 20)], ['d2', 'cats beta', meta('alice', 21)], ['d3', 'cats gamma', meta('alice', 22)]);
  seed(ctx, 'message_embeddings', rows);
  const { similar } = await ctx.retriever.retrieveForReply('alice', record);
  assert.equal(similar.length, 3);
  assert.equal(similar.filter((text) => text.startsWith('cats rule')).length, 1);
});

test('looks up embeddings once, for the distinct ids of every candidate', async () => {
  const ctx = await setup();
  seed(ctx, 'message_embeddings', [['1', 'cats rule', meta('alice', 1, { has_gif: true })]]);
  seed(ctx, 'message_reply_embeddings', [['1', 'cats rule', meta('alice', 1)]]);
  store(ctx, 'x', 'alice', 'plain text here', 2);
  const calls = [];
  const original = ctx.vectorStore.getEmbeddings;
  ctx.vectorStore.getEmbeddings = (ids) => { calls.push(ids); return original(ids); };
  await ctx.retriever.retrieveForReply('alice', record);
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0]].sort(), ['1', 'x']);
});

test('uses the messages-collection embedding, not the reply row embedding', async () => {
  const ctx = await setup();
  const parentVector = fakeEmbed('some parent message text');
  seed(ctx, 'message_embeddings', [
    ['r1', 'first reply of mine today', meta('alice', 1)],
    ['r2', 'completely other words here', meta('alice', 2)],
  ]);
  ctx.fake.state.collection('message_reply_embeddings').seed([
    { id: 'r1', document: 'first reply of mine today', metadata: meta('alice', 1), embedding: parentVector },
    { id: 'r2', document: 'completely other words here', metadata: meta('alice', 2), embedding: parentVector },
  ]);
  const { replies } = await ctx.retriever.retrieveForReply('alice', record);
  assert.deepEqual(replies.map((e) => e.you).sort(), ['completely other words here', 'first reply of mine today']);
});

test('falls back to key-only dedup and warns when embeddings cannot be loaded', async () => {
  const ctx = await setup();
  seed(ctx, 'message_embeddings', [
    ['1', 'ok see you tomorrow then', meta('alice', 1)],
    ['2', 'see you tomorrow then ok', meta('alice', 2)],
    ['3', 'See you tomorrow then ok!', meta('alice', 3)],
  ]);
  ctx.vectorStore.getEmbeddings = async () => { throw new Error('chroma down'); };
  const { similar } = await ctx.retriever.retrieveForReply('alice', record);
  assert.equal(similar.length, 2);
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /chroma down/);
});

test('merges near-duplicates by embedding when the keys differ', async () => {
  const ctx = await setup();
  seed(ctx, 'message_embeddings', [
    ['1', 'ok see you tomorrow then', meta('alice', 1)],
    ['2', 'see you tomorrow then ok', meta('alice', 2)],
  ]);
  const { similar } = await ctx.retriever.retrieveForReply('alice', record);
  assert.equal(similar.length, 1);
});

test('frequent sums the counts of merged variants and uses the kept text', async () => {
  const ctx = await setup();
  const spellings = ['lol', 'lol', 'lol', 'lol', 'LOL', 'LOL'];
  spellings.forEach((content, i) => store(ctx, `l${i}`, 'alice', content, i + 1));
  store(ctx, 'late', 'alice', 'lol', 500);
  seed(ctx, 'message_embeddings', [
    ['l0', 'lol', meta('alice', 1)], ['l4', 'LOL', meta('alice', 5)],
    ['one', 'only once', meta('alice', 9)],
  ]);
  store(ctx, 'one', 'alice', 'only once', 9);
  const { similar, frequent } = await ctx.retriever.retrieveForReply('alice', record);
  assert.deepEqual(similar.sort(), ['lol', 'only once']);
  assert.deepEqual(frequent, [{ text: 'lol', times: 6 }]);
});

test('frequent is limited, sorted by count and ties keep first appearance', async () => {
  const ctx = await setup({ frequentLimit: 2, frequentMinCount: 2, similarResults: 5, otherResults: 0 });
  const plan = { aaa: 2, bbb: 3, ccc: 3, ddd: 2 };
  let n = 0;
  Object.entries(plan).forEach(([content, times]) => {
    for (let i = 0; i < times; i += 1) store(ctx, `m${n += 1}`, 'alice', content, n);
    seed(ctx, 'message_embeddings', [[`id-${content}`, content, meta('alice', n)]]);
  });
  const { frequent } = await ctx.retriever.retrieveForReply('alice', { ...record, content: 'aaa bbb ccc ddd' });
  assert.equal(frequent.length, 2);
  assert.ok(frequent.every((f) => f.times === 3));
});

test('retrieveForRevive over-fetches, dedupes by key and cuts to reviveSamples', async () => {
  const ctx = await setup({ reviveSamples: 2 });
  ['lol', 'LOL', 'lolll', 'second text', 'third text', 'fourth text'].forEach((content, i) => {
    store(ctx, `a${i}`, 'alice', content, i);
  });
  const out = await ctx.retriever.retrieveForRevive('alice');
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map((t) => t.toLowerCase().replace(/l+$/, 'l'))).size, 2);
});
