import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServices, buildGifResolver } from '../../../src/container/services.js';
import { buildStorage } from '../../../src/container/storage.js';
import { makeParts, buildAll } from '../../support/containerParts.js';

test('returns the ingest, retrieval, generation and gif services', () => {
  const { services, storage } = buildAll();
  assert.deepEqual(Object.keys(services).sort(), [
    'burstProfile', 'chatClient', 'composer', 'generator', 'gifResolver', 'ingest', 'personaSelector', 'retriever', 'vectorHealth', 'vectorSync',
  ]);
  assert.deepEqual(Object.keys(services.generator).sort(), ['generateConversationTurn', 'generateReply', 'generateRevive']);
  assert.deepEqual(Object.keys(services.retriever).sort(), ['retrieveForReply', 'retrieveForRevive']);
  storage.db.close();
});

test('a missing DeepSeek key builds a client that fails on use with a config error, without constructing OpenAI', async () => {
  const parts = makeParts({ DEEPSEEK_API_KEY: '' });
  const storage = buildStorage(parts);
  const services = buildServices({ ...parts, storage });
  assert.deepEqual(parts.fakes.llm.state.constructed, []);
  await assert.rejects(services.generator.generateRevive('alice', {}), /DEEPSEEK_API_KEY is not set/);
  storage.db.close();
});

test('a vector failure during ingest is reported to the vector health', async () => {
  const { services, storage, fakes } = buildAll();
  fakes.chroma.state.failHeartbeat(null);
  await storage.vectorStore.connect();
  fakes.chroma.state.failCollection('message_embeddings', new Error('chroma down'), ['upsert']);
  const record = { id: 'm1', author: 'alice', content: 'hello there friends', timestamp: 1, reference: null };
  const outcome = await services.ingest.recordMessage(record, { tolerateVectorErrors: true });
  assert.equal(outcome.vectorFailed, true);
  storage.db.close();
});

test('buildGifResolver builds only the engines whose key is set', async () => {
  const parts = makeParts({ KLIPY_API_KEY: '', GIPHY_API_KEY: '', HUMOR_API_KEY: '' });
  const resolver = buildGifResolver(parts);
  const { gifLinks } = await resolver.resolve('<gif! cat>');
  assert.deepEqual(gifLinks, [{ match: '<gif! cat>', url: '' }]);
  assert.deepEqual(parts.fakes.gifs.state.constructed, []);
});
