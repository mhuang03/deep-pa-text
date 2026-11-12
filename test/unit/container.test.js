import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Events } from 'discord.js';
import { openDatabase } from '../../src/storage/database.js';
import { createMetaStore } from '../../src/storage/metaStore.js';
import { buildContainer, buildGifResolver, defaultClock } from '../../src/container.js';
import { loadConfig, isConfigError } from '../../src/config.js';
import { createFakeDiscord } from '../support/fakes/discord.js';
import { createFakeChroma } from '../support/fakes/chroma.js';
import { createFakeOpenAI } from '../support/fakes/llm.js';
import { createFakeGifs } from '../support/fakes/gifs.js';
import { ENV, PING_CACHE, USERS } from '../support/fixtures.js';

const SERVICES = [
  'bot', 'lifecycle', 'client', 'db', 'logger', 'vectorStore', 'messageStore', 'messageFilter', 'ingest',
  'retriever', 'personaSelector', 'generator', 'gifResolver', 'composer', 'delivery', 'responder', 'userDirectory',
  'botMessageStore', 'botMessageResolver', 'contextBuilder', 'chainBuilder', 'burstProfile',
  'profileStore', 'metaStore', 'memberProfiles', 'webhooks',
  'historyReader', 'historyImporter', 'botMessageImporter', 'vectorSync', 'vectorHealth',
];

const setup = (overrides = {}, databasePath = ':memory:', env = ENV) => {
  const fakes = {
    discord: createFakeDiscord(), chroma: createFakeChroma(), llm: createFakeOpenAI(), gifs: createFakeGifs(),
  };
  const vendor = {
    Client: fakes.discord.Client,
    ChromaClient: fakes.chroma.ChromaClient,
    OpenAIEmbeddingFunction: fakes.chroma.OpenAIEmbeddingFunction,
    OpenAI: fakes.llm.OpenAI,
    GiphyFetch: fakes.gifs.GiphyFetch,
    fetch: fakes.gifs.fetch,
  };
  const config = loadConfig({ ...env, ...overrides });
  const storage = { ...config.storage, databasePath };
  const container = buildContainer({
    config: { ...config, storage }, vendor, data: { users: USERS, pingCache: PING_CACHE },
  });
  return { fakes, container, config };
};

test('exposes the listed services', () => {
  const { container } = setup();
  assert.deepEqual(Object.keys(container).sort(), [...SERVICES].sort());
  assert.equal(typeof container.bot.start, 'function');
  assert.equal(container.userDirectory.nameOf('alice'), 'Alice Example');
  container.db.close();
});

test('constructs each third-party client once with the configured options', () => {
  const { fakes, config, container } = setup({ CHROMA_PORT: '9000' });
  assert.deepEqual(fakes.chroma.state.constructed, [{ port: 9000 }]);
  assert.deepEqual(fakes.chroma.state.embeddingFunctionOptions, { ...config.embedding });
  assert.deepEqual(fakes.llm.state.constructed, [
    { apiKey: ENV.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com', timeout: 120000, maxRetries: 1 },
  ]);
  assert.deepEqual(fakes.gifs.state.constructed, [[ENV.GIPHY_API_KEY]]);
  assert.deepEqual(fakes.discord.state.clientOptions.intents.length, 3);
  container.db.close();
});

test('constructs nothing that connects until the bot starts', async () => {
  const { fakes, container } = setup();
  assert.deepEqual(fakes.discord.state.loginTokens, []);
  await container.vectorStore.connect();
  await container.bot.start();
  assert.deepEqual(fakes.discord.state.loginTokens, [ENV.DISCORD_BOT_TOKEN]);
  assert.ok(fakes.discord.state.client.listenerCount(Events.MessageCreate) === 1);
  container.db.close();
});

test('opens the configured database and creates the schema', () => {
  const { container } = setup();
  const tables = container.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.deepEqual(tables.map((row) => row.name).sort(), ['bot_messages', 'filtered_messages', 'message_revisions', 'messages', 'meta', 'user_profiles']);
  container.db.close();
});

test('the ingest service stores through the wired services', async () => {
  const { container } = setup();
  await container.vectorStore.connect();
  const record = { id: 'm1', author: 'alice', content: 'hello there friends', timestamp: 1, reference: null };
  const { filtered } = await container.ingest.recordMessage(record);
  assert.equal(filtered.content, 'hello there friends');
  assert.deepEqual(container.messageStore.latestFiltered(5).map((row) => row.id), ['m1']);
  container.db.close();
});

test('buildGifResolver resolves through the vendor fetch and GiphyFetch', async () => {
  const fakes = createFakeGifs();
  fakes.state.klipy.setResult('https://gif.example/a.gif');
  const resolver = buildGifResolver({
    config: loadConfig(ENV), vendor: { GiphyFetch: fakes.GiphyFetch, fetch: fakes.fetch },
  });
  const { gifLinks } = await resolver.resolve('<gif! cat>');
  assert.deepEqual(gifLinks, [{ match: '<gif! cat>', url: 'https://gif.example/a.gif' }]);
});

test('defaultClock wraps the globals lazily', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 });
  const clock = defaultClock();
  t.mock.method(Math, 'random', () => 0.25);
  assert.equal(clock.now(), 1000);
  assert.equal(clock.random(), 0.25);
  const ticks = [];
  clock.setInterval(() => ticks.push(clock.now()), 100);
  t.mock.timers.tick(250);
  assert.equal(ticks.length >= 1, true);
  const fired = [];
  const handle = clock.setTimeout(() => fired.push('late'), 100);
  clock.setTimeout(() => fired.push('on time'), 100);
  clock.clearTimeout(handle);
  t.mock.timers.tick(100);
  assert.deepEqual(fired, ['on time']);
});

test('the default persona display wires the embed delivery and never touches webhooks', () => {
  const { container } = setup();
  assert.equal(container.delivery.deliver.length, 1);
  assert.equal(typeof container.delivery.placeholder, 'function');
  assert.equal(typeof container.webhooks.forChannel, 'function');
  container.db.close();
});

test('PERSONA_DISPLAY=webhook wires the webhook delivery', async () => {
  const embed = setup();
  const hook = setup({ PERSONA_DISPLAY: 'webhook' });
  const placeholder = await hook.container.delivery.placeholder({ persona: 'bob', guild: {} });
  assert.equal(placeholder.content, 'Replying as bob…');
  const embedPlaceholder = await embed.container.delivery.placeholder({ persona: 'bob', guild: hook.fakes.discord.state.guild });
  assert.equal(embedPlaceholder.embeds.length, 1);
  embed.container.db.close();
  hook.container.db.close();
});

const GENERATION = 'g20261112180000';

test('an existing database without a generation uses the configured collection names', async () => {
  const { fakes, container } = setup();
  await container.vectorStore.connect();
  assert.equal(fakes.chroma.state.collection('message_embeddings').name, 'message_embeddings');
  container.db.close();
});

test('a database that names a generation uses that generation\'s collections', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-container-'));
  const databasePath = path.join(dir, 'messages.db');
  const seeded = openDatabase(databasePath);
  createMetaStore({ db: seeded }).setIfAbsent('chroma_generation', GENERATION);
  seeded.close();
  const { fakes, container } = setup({}, databasePath);
  await container.vectorStore.connect();
  assert.equal(fakes.chroma.state.collection(`message_embeddings_${GENERATION}`).name, `message_embeddings_${GENERATION}`);
  assert.equal(fakes.chroma.state.collection(`message_reply_embeddings_${GENERATION}`).name, `message_reply_embeddings_${GENERATION}`);
  assert.throws(() => fakes.chroma.state.collection('message_embeddings'));
  container.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uses a given Discord client instead of creating one', () => {
  const fakes = {
    discord: createFakeDiscord(), chroma: createFakeChroma(), llm: createFakeOpenAI(), gifs: createFakeGifs(),
  };
  const vendor = {
    Client: fakes.discord.Client, ChromaClient: fakes.chroma.ChromaClient,
    OpenAIEmbeddingFunction: fakes.chroma.OpenAIEmbeddingFunction, OpenAI: fakes.llm.OpenAI,
    GiphyFetch: fakes.gifs.GiphyFetch, fetch: fakes.gifs.fetch,
  };
  const client = new fakes.discord.Client({ given: true });
  const config = loadConfig(ENV);
  const container = buildContainer({
    config: { ...config, storage: { ...config.storage, databasePath: ':memory:' } },
    vendor, data: { users: USERS, pingCache: PING_CACHE }, client,
  });
  assert.equal(container.client, client);
  assert.deepEqual(fakes.discord.state.clientOptions, { given: true }, 'no second client was constructed');
  container.db.close();
});

const gifVendor = (fakes) => ({ GiphyFetch: fakes.GiphyFetch, fetch: fakes.fetch });

const KEY_SUBSETS = [
  { keys: {}, called: [] },
  { keys: { KLIPY_API_KEY: 'k' }, called: ['klipy'] },
  { keys: { GIPHY_API_KEY: 'g' }, called: ['giphy'] },
  { keys: { HUMOR_API_KEY: 'h' }, called: ['humor'] },
  { keys: { GIPHY_API_KEY: 'g', HUMOR_API_KEY: 'h' }, called: ['giphy', 'humor'] },
  { keys: { KLIPY_API_KEY: 'k', GIPHY_API_KEY: 'g', HUMOR_API_KEY: 'h' }, called: ['klipy', 'giphy', 'humor'] },
];

test('buildGifResolver builds and calls only the engines whose key is set', async () => {
  for (const { keys, called } of KEY_SUBSETS) {
    const fakes = createFakeGifs();
    const resolver = buildGifResolver({ config: loadConfig(keys), vendor: gifVendor(fakes) });
    await resolver.resolve('<gif! cat>');
    const seen = ['klipy', 'giphy', 'humor'].filter((name) => fakes.state[name].calls.length > 0);
    assert.deepEqual(seen, called, JSON.stringify(keys));
    assert.equal(fakes.state.constructed.length, keys.GIPHY_API_KEY ? 1 : 0, 'GiphyFetch only with its key');
  }
});

test('with no GIF key a token stays unresolved as placeholder text', async () => {
  const resolver = buildGifResolver({ config: loadConfig({}), vendor: gifVendor(createFakeGifs()) });
  const { content, gifLinks } = await resolver.resolve('hi <gif! cat>');
  assert.equal(content, 'hi <INSERT GIF:  cat>');
  assert.deepEqual(gifLinks, [{ match: '<gif! cat>', url: '' }]);
});

test('without DEEPSEEK_API_KEY the SDK client is never built and generating rejects naming the variable', async () => {
  const { OPENAI_API_KEY, ...rest } = ENV;
  const { DEEPSEEK_API_KEY, ...withoutDeepseek } = { ...rest, OPENAI_API_KEY };
  assert.ok(DEEPSEEK_API_KEY);
  const { fakes, container } = setup({}, ':memory:', withoutDeepseek);
  assert.deepEqual(fakes.llm.state.constructed, []);
  await assert.rejects(
    container.generator.generateRevive('alice'),
    (error) => isConfigError(error) && error.message.includes('DEEPSEEK_API_KEY'),
  );
  container.db.close();
});

test('the database is opened with the configured busy timeout', () => {
  const { container } = setup({}, ':memory:');
  assert.equal(container.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  container.db.close();
});
