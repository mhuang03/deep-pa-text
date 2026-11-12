// The only construction-aware file: it builds the app through buildContainer with the
// world's fakes as the vendor, then maps the spec 00 subject surface onto the services.
import { loadConfig } from '../../src/config.js';
import { buildContainer } from '../../src/container.js';
import { BUCKET_ORDER } from '../../src/retrieval/retriever.js';
import { buildReplyPrompt, buildRevivePrompt, SYSTEM_PROMPT } from '../../src/llm/prompts.js';
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

const buildConfig = (env) => {
  const config = loadConfig(env);
  return { ...config, storage: { ...config.storage, databasePath: IN_MEMORY } };
};

const buildSubject = (container) => {
  const { messageFilter, ingest, retriever, personaSelector, generator, gifResolver } = container;
  return {
    filter: (msg) => messageFilter.filter(msg),
    filterAnyAuthor: (msg) => messageFilter.filterAnyAuthor(msg),
    recordMessage: async (msg) => {
      await ingest.recordMessage({ ...msg, reference: msg.reference ?? null });
    },
    semanticSearch: async (author, msg) => {
      const buckets = await retriever.retrieveForReply(author, msg);
      return BUCKET_ORDER.map((key) => buckets[key]);
    },
    randomSearch: (author) => retriever.retrieveForRevive(author),
    searchLikelyRepliers: (msg) => personaSelector.likelyRepliers(msg),
    getRAGResponse: (author, msg) => generator.generateReply(author, msg),
    getRandomResponse: (author) => generator.generateRevive(author),
    processGIFs: (text) => gifResolver.resolve(text),
    SYSTEM_PROMPT,
    ragInput: (author, name, message, replies, similar, gifs, other) =>
      buildReplyPrompt({ author, name, message, buckets: { replies, similar, gifs, other } }),
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

export const bootBot = async (world) => {
  const fakes = createFakes(world.options);
  world.fakes = fakes;
  const container = buildContainer({
    config: buildConfig(world.env),
    vendor: buildVendor(fakes),
    data: { users: world.options.users, pingCache: world.options.pingCache },
  });
  const dispose = () => container.db.close();
  try {
    await container.vectorStore.connect();
    await container.bot.start();
  } catch (error) {
    dispose();
    throw error;
  }
  return { subject: buildSubject(container), sqlite: buildSqlite(container.db), dispose };
};
