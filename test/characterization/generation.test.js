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

const seedAll = (world, author, contents, prefix = 's') =>
  world.seed(contents.map((content, i) => msg(`${prefix}${i}`, author, content, T0 + 1000 + i * 10)));

const sorted = (xs) => [...xs].sort();

// The prompt puts each JSON array alone on a line starting with '['.
const parseArrays = (prompt) => prompt.split('\n').filter((line) => line.startsWith('[')).map((line) => JSON.parse(line));

const assertRequestShape = (world, userContent) => {
  assert.equal(world.llm.calls.length, 1);
  const request = world.llm.calls[0];
  assert.equal(request.model, 'deepseek-v4-flash');
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.stream, false);
  assert.deepEqual(request.messages, [
    { role: 'system', content: world.subject.SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]);
};

test('getRAGResponse resolves to the response content of one deepseek chat request', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('sounds good to me');
  const m = msg('q', 'bob', 'hello world', QUERY_TIME);
  const result = await world.subject.getRAGResponse('alice', m);
  assert.equal(result, 'sounds good to me');
  assert.equal(world.llm.calls.length, 1);
  const request = world.llm.calls[0];
  assert.equal(request.model, 'deepseek-v4-flash');
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.stream, false);
  assert.deepEqual(request.messages.map((x) => x.role), ['system', 'user']);
  assert.equal(request.messages[0].content, world.subject.SYSTEM_PROMPT);
});

test('getRAGResponse sends the request through the client built with the deepseek key and base url', async (t) => {
  const world = await newWorld(t);
  await world.subject.getRAGResponse('alice', msg('q', 'bob', 'hello world', QUERY_TIME));
  assert.deepEqual(world.llm.callClients, [
    { apiKey: world.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' },
  ]);
});

test('getRAGResponse user message is ragInput built from the four semanticSearch buckets', async (t) => {
  const world = await newWorld(t);
  await seedAll(world, 'alice', ['pizza friday night', 'cat dance clip', 'plain lonely text']);
  world.chroma.collection('message_embeddings').rows.delete('s2');
  world.chroma.collection('message_embeddings').seed([
    { id: 's1', document: 'cat dance clip', metadata: { author: 'alice', timestamp: T0 + 1010, has_gif: true } },
  ]);
  world.chroma.collection('message_reply_embeddings').seed([
    { id: 'r1', document: 'reply bucket text', metadata: { author: 'alice', timestamp: T0 } },
  ]);
  const m = msg('q', 'bob', 'pizza on friday', QUERY_TIME);
  await world.subject.getRAGResponse('alice', m);

  const userContent = world.llm.calls[0].messages[1].content;
  const buckets = parseArrays(userContent);
  const expected = await world.subject.semanticSearch('alice', m);
  assert.equal(buckets.length, 4);
  buckets.forEach((bucket, i) => assert.deepEqual(sorted(bucket), sorted(expected[i])));
  assert.equal(userContent, world.subject.ragInput('alice', 'Alice Example', m.content, ...buckets));
  assertRequestShape(world, userContent);
});

test('getRandomResponse sends contextlessInput built from a subset of the persona messages', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('random reply text');
  const contents = ['bob first line', 'bob second line', 'bob third line'];
  await seedAll(world, 'bob', contents);
  await seedAll(world, 'alice', ['alice other line'], 'a');
  const result = await world.subject.getRandomResponse('bob');
  assert.equal(result, 'random reply text');

  const userContent = world.llm.calls[0].messages[1].content;
  const [shown] = parseArrays(userContent);
  assert.deepEqual(sorted(shown), sorted(contents));
  assert.equal(userContent, world.subject.contextlessInput('bob', 'Bob Example', shown));
  assertRequestShape(world, userContent);
  assert.deepEqual(world.llm.callClients, [
    { apiKey: world.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' },
  ]);
});

test('getRAGResponse rejects with the LLM error', async (t) => {
  const world = await newWorld(t);
  const error = new Error('llm down');
  world.llm.respondWith(error);
  await assert.rejects(world.subject.getRAGResponse('alice', msg('q', 'bob', 'hello world', QUERY_TIME)), error);
});

test('getRandomResponse rejects with the LLM error', async (t) => {
  const world = await newWorld(t);
  const error = new Error('llm down');
  world.llm.respondWith(error);
  await assert.rejects(world.subject.getRandomResponse('bob'), error);
});
