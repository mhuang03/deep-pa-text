import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { buildContainer, buildGifResolver, defaultClock } from '../../src/container.js';
import { loadConfig } from '../../src/config.js';
import { createFakeDiscord } from '../support/fakes/discord.js';
import { createFakeChroma } from '../support/fakes/chroma.js';
import { createFakeOpenAI } from '../support/fakes/llm.js';
import { createFakeGifs } from '../support/fakes/gifs.js';
import { ENV, PING_CACHE, USERS } from '../support/fixtures.js';

const SERVICES = [
  'bot', 'client', 'db', 'logger', 'vectorStore', 'messageStore', 'messageFilter', 'ingest',
  'retriever', 'personaSelector', 'generator', 'gifResolver', 'composer', 'delivery', 'responder', 'userDirectory',
];

const setup = (overrides = {}) => {
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
  const config = loadConfig({ ...ENV, ...overrides });
  const storage = { ...config.storage, databasePath: ':memory:' };
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
  assert.deepEqual(tables.map((row) => row.name).sort(), ['filtered_messages', 'messages']);
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
