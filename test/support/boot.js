// The only construction-aware file: it builds the app through buildContainer with the
// world's fakes as the vendor, then maps the spec 00 subject surface onto the services.
import { loadConfig } from '../../src/config.js';
import { createStartup } from '../../src/bot/startup.js';
import { buildContainer, defaultClock } from '../../src/container.js';
import { BUCKET_ORDER } from '../../src/retrieval/retriever.js';
import { buildReplyPrompt, buildRevivePrompt, SYSTEM_PROMPT, REVIVE_SYSTEM_PROMPT } from '../../src/llm/prompts.js';
import { parkWhile } from './fakes/parking.js';
import { createFakeDiscord } from './fakes/discord.js';
import { createFakeChroma } from './fakes/chroma.js';
import { createFakeOpenAI } from './fakes/llm.js';
import { createFakeGifs } from './fakes/gifs.js';

const IN_MEMORY = ':memory:';

const createFakes = (options) => {
  const fakes = {
    discord: createFakeDiscord(),
    chroma: createFakeChroma(),
    llm: createFakeOpenAI(),
    gifs: createFakeGifs(),
  };
  if (options.failHeartbeat) fakes.chroma.state.failHeartbeat(options.failHeartbeat);
  options.users.forEach(({ username, id }) => fakes.discord.state.guild.members.add({ username, id }));
  return fakes;
};

const buildVendor = (fakes) => ({
  Client: fakes.discord.Client,
  ChromaClient: fakes.chroma.ChromaClient,
  OpenAIEmbeddingFunction: fakes.chroma.OpenAIEmbeddingFunction,
  OpenAI: fakes.llm.OpenAI,
  GiphyFetch: fakes.gifs.GiphyFetch,
  // The world mocks global fetch; resolving it lazily honours that mock.
  fetch: (...args) => globalThis.fetch(...args),
});

// `overrides` replaces keys inside whole config sections, for tunables that have no environment variable.
const mergeSections = (config, overrides) => Object.fromEntries(
  Object.entries(config).map(([name, section]) => [name, { ...section, ...overrides[name] }]),
);

const buildConfig = (env, overrides = {}) => {
  const config = mergeSections(loadConfig(env), overrides);
  return { ...config, storage: { ...config.storage, databasePath: IN_MEMORY } };
};

const toExample = (entry) => (typeof entry === 'string' ? { you: entry, them: null } : entry);

const buildSubject = (container, { timeZone: contextTimeZone, maxEntryChars }) => {
  const { messageFilter, ingest, retriever, personaSelector, generator, gifResolver } = container;
  return {
    filter: (msg) => messageFilter.filter(msg),
    filterAnyAuthor: (msg) => messageFilter.filterAnyAuthor(msg),
    recordMessage: async (msg) => {
      await ingest.recordMessage({ ...msg, reference: msg.reference ?? null });
    },
    recordEdit: (msg, options) => ingest.recordEdit({ ...msg, reference: msg.reference ?? null }, options),
    recordDelete: (id, at) => ingest.recordDelete(id, at),
    semanticSearch: async (author, msg) => {
      const buckets = await retriever.retrieveForReply(author, msg);
      return BUCKET_ORDER.map((key) => (key === 'replies' ? buckets[key].map((e) => e.you) : buckets[key]));
    },
    randomSearch: (author) => retriever.retrieveForRevive(author),
    searchLikelyRepliers: (msg) => personaSelector.likelyRepliers(msg),
    getRAGResponse: async (author, msg) => (await generator.generateReply(author, msg)).response,
    getRandomResponse: async (author) => (await generator.generateRevive(author)).response,
    processGIFs: (text) => gifResolver.resolve(text),
    SYSTEM_PROMPT,
    REVIVE_SYSTEM_PROMPT,
    ragInput: (author, name, message, replies, similar, gifs, other, { messageAuthor, transcript = [] } = {}) =>
      buildReplyPrompt({
        author, name, message, messageAuthor, transcript, timeZone: contextTimeZone,
        maxEntryChars,
        buckets: { replies: replies.map(toExample), similar, gifs, other },
      }),
    contextlessInput: (author, name, examples) => buildRevivePrompt({ author, name, examples }),
  };
};

const buildSqlite = (db) => {
  const plain = (rows) => rows.map((row) => ({ ...row }));
  return {
    all: (sql, ...params) => plain(db.prepare(sql).all(...params)),
    get: (sql, ...params) => {
      const row = db.prepare(sql).get(...params);
      return row && { ...row };
    },
  };
};

// Records every sleep and resolves at once; a test's hook runs while the sleeping handler is parked.
const buildClock = (world) => ({
  ...defaultClock(),
  sleep: async (ms) => {
    world.sleeps.push(ms);
    if (world.sleepHook) await parkWhile(() => world.sleepHook(ms));
  },
});

export const bootBot = async (world) => {
  const fakes = createFakes(world.options);
  world.fakes = fakes;
  const config = buildConfig(world.env, world.options.config);
  world.exits = [];
  world.databaseClosed = 0;
  const container = buildContainer({
    config,
    vendor: buildVendor(fakes),
    clock: buildClock(world),
    data: { users: world.options.users, pingCache: world.options.pingCache },
    exit: (code) => {
      world.exits.push(code);
      world.options.exit?.(code);
    },
    // The handle stays open after shutdown so tests can read the database; dispose closes it.
    closeDatabase: () => {
      world.databaseClosed += 1;
    },
  });
  const dispose = () => container.db.close();
  try {
    await world.options.preload?.(container);
    const { metaStore, vectorStore, bot } = container;
    await createStartup({ metaStore, vectorStore, bot, config }).run();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    subject: buildSubject(container, config.context), sqlite: buildSqlite(container.db), container, dispose,
  };
};
