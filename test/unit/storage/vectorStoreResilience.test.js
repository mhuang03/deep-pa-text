import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChroma, FAKE_DIMENSIONS } from '../../support/fakes/chroma.js';
import { createVectorStore } from '../../../src/storage/vectorStore.js';
import { createManualClock, flush, CHROMA_LIMITS } from '../../support/clocks.js';
import { isConfigError } from '../../../src/config/errors.js';

const config = {
  chroma: {
    messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings', ...CHROMA_LIMITS,
  },
  embedding: { dimensions: FAKE_DIMENSIONS },
};
const m = (id, content, extra = {}) => ({ id, author: 'a', content, timestamp: 10, reference: null, ...extra });

const setup = (overrides = {}) => {
  const fake = createFakeChroma();
  const clock = createManualClock();
  const client = new fake.ChromaClient({});
  const embeddingFunction = new fake.OpenAIEmbeddingFunction({});
  const store = createVectorStore({
    client, embeddingFunction, config: { ...config, ...overrides }, clock,
  });
  return { fake, clock, client, embeddingFunction, store };
};

// Starts the call, lets it reach the hung Chroma, fires its timer and returns the rejection.
const timeOut = async (clock, call) => {
  const outcome = call().then(() => null, (error) => error);
  await flush();
  clock.fireNext();
  return outcome;
};

const METHODS = {
  embed: (store) => store.embed('hello'),
  upsertMessages: (store) => store.upsertMessages([m('1', 'x')]),
  query: (store) => store.query('messages', { text: 'x', limit: 1 }),
  getEmbeddings: (store) => store.getEmbeddings(['1']),
  getRecords: (store) => store.getRecords('messages', ['1']),
  fillMetadata: (store) => store.fillMetadata('messages', [{ id: '1', document: 'x', metadata: {}, embedding: [1] }]),
  addReplyRows: (store) => store.addReplyRows([{ message: m('1', 'x'), embedding: [1] }]),
};

Object.entries(METHODS).forEach(([name, call]) => {
  test(`${name} times out when Chroma hangs and the error is tagged with its cause`, async () => {
    const { fake, clock, store } = setup();
    await store.connect();
    fake.state.hang(true);
    const error = await timeOut(clock, () => call(store));
    assert.equal(error.isVectorError, true);
    assert.match(error.message, /^chroma \w+ timed out after \d+ ms$/);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.isVectorError, undefined);
  });
});

test('connect times out on a hung heartbeat after the connect timeout', async () => {
  const { fake, clock, store } = setup();
  fake.state.hang(true);
  const error = await timeOut(clock, () => store.connect());
  assert.equal(error.message, 'chroma connect timed out after 10000 ms');
  assert.equal(error.isVectorError, true);
});

test('interactive calls use the timeout and batch operations the batch timeout', async () => {
  const { clock, store } = setup();
  await store.connect();
  const delaysOf = async (call) => {
    const before = clock.scheduled.length;
    await call();
    return clock.scheduled.slice(before);
  };
  assert.deepEqual(await delaysOf(() => store.upsertMessages([m('1', 'x')])), [30000]);
  assert.deepEqual(await delaysOf(() => store.upsertMessages([m('2', 'y'), m('3', 'z')])), [120000]);
  assert.deepEqual(await delaysOf(() => store.getRecords('messages', ['1'])), [120000]);
  assert.deepEqual(await delaysOf(() => store.getEmbeddings(['1'])), [30000]);
});

test('a hung collection lookup times out and is not cached: the next call retries and succeeds', async () => {
  const { fake, clock, client, store } = setup();
  const names = [];
  const original = client.getOrCreateCollection.bind(client);
  client.getOrCreateCollection = (args) => {
    names.push(args.name);
    return original(args);
  };
  fake.state.hang(true);
  const first = await timeOut(clock, () => store.upsertMessages([m('1', 'x')]));
  assert.equal(first.message, 'chroma getOrCreateCollection timed out after 30000 ms');
  fake.state.hang(false);
  await store.upsertMessages([m('1', 'x')]);
  assert.equal(fake.state.collection('message_embeddings').rows.size, 1);
  assert.equal(names.filter((n) => n === 'message_embeddings').length, 2);
});

test('a collection lookup that rejects is evicted too', async () => {
  const { client, store } = setup();
  const original = client.getOrCreateCollection.bind(client);
  let failures = 1;
  client.getOrCreateCollection = (args) => (failures-- > 0 ? Promise.reject(new Error('boom')) : original(args));
  await assert.rejects(store.connect(), (error) => error.isVectorError === true && /boom/.test(error.message));
  await store.connect();
});

test('a tagged error is a new error: the original is not mutated and is kept as the cause', async () => {
  const { fake, store } = setup();
  await store.connect();
  const boom = new Error('rate limited');
  fake.state.collection('message_embeddings').setFailing(boom);
  await assert.rejects(store.upsertMessages([m('1', 'x')]), (error) => {
    assert.notEqual(error, boom);
    assert.equal(error.cause, boom);
    assert.equal(error.message, 'rate limited');
    assert.equal(error.isVectorError, true);
    assert.equal(boom.isVectorError, undefined);
    return true;
  });
});

test('an embedding failure is tagged', async () => {
  const { fake, store } = setup();
  fake.state.embedder.setFailing(new Error('429 too many requests'));
  await assert.rejects(store.embed('x'), (error) => error.isVectorError === true && /429/.test(error.message));
});

test('argument validation errors are thrown untagged', async () => {
  const { store } = setup();
  await assert.rejects(store.query('messages', { text: 'a', embedding: [1], limit: 1 }), (error) =>
    /exactly one of embedding or text/.test(error.message) && error.isVectorError === undefined);
  await assert.rejects(store.getRecords('nope', ['1']), (error) =>
    /Unknown collection: nope/.test(error.message) && error.isVectorError === undefined);
});

test('upsertMessages of an empty batch makes no Chroma call', async () => {
  const { fake, client, store } = setup();
  let lookups = 0;
  client.getOrCreateCollection = async () => {
    lookups += 1;
    throw new Error('unreachable');
  };
  await store.upsertMessages([]);
  await store.fillMetadata('messages', []);
  await store.addReplyRows([]);
  assert.equal(lookups, 0);
  assert.equal(fake.state.embeddingCalls, 0);
});

test('a batch with a repeated id keeps the last occurrence', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'first'), m('2', 'other'), m('1', 'last')]);
  const rows = fake.state.collection('message_embeddings').rows;
  assert.equal(rows.size, 2);
  assert.equal(rows.get('1').document, 'last');
});

test('fillMetadata and addReplyRows drop repeated ids, keeping the last', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'parent text')]);
  const embedding = fake.state.collection('message_embeddings').rows.get('1').embedding;
  await store.fillMetadata('messages', [
    { id: '1', document: 'parent text', metadata: { a: 1 }, embedding },
    { id: '1', document: 'parent text', metadata: { a: 2 }, embedding },
  ]);
  assert.deepEqual(fake.state.collection('message_embeddings').rows.get('1').metadata, { a: 2 });
  const reply = (content) => ({ message: m('2', content, { reference: '1' }), embedding });
  await store.addReplyRows([reply('one'), reply('two')]);
  assert.equal(fake.state.collection('message_reply_embeddings').rows.get('2').document, 'two');
});

test('connect accepts an empty collection and one whose embeddings match the configured dimensions', async () => {
  const { fake, store } = setup();
  await store.connect();
  fake.state.collection('message_embeddings').seed([{ id: '1', document: 'x', metadata: {} }]);
  await store.connect();
});

test('connect rejects a collection whose stored embeddings differ in length, without an embedding request', async () => {
  const { fake, store } = setup({ embedding: { dimensions: 512 } });
  await store.connect();
  fake.state.collection('message_embeddings').seed([{ id: '1', document: 'x', metadata: {} }]);
  const calls = fake.state.embeddingCalls;
  await assert.rejects(store.connect(), (error) => {
    assert.equal(isConfigError(error), true);
    assert.equal(error.isVectorError, undefined);
    assert.match(error.message, /64-dimension .* embedding\.dimensions is 512/);
    return true;
  });
  assert.equal(fake.state.embeddingCalls, calls);
});
