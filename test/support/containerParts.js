// Builds the layers of the container step by step with fakes at the third-party boundary.
import { loadConfig } from '../../src/config.js';
import { buildStorage } from '../../src/container/storage.js';
import { buildServices } from '../../src/container/services.js';
import { buildDiscord } from '../../src/container/discord.js';
import { buildOrchestration, buildLifecycle } from '../../src/container/bot.js';
import { buildBackfill } from '../../src/container/backfill.js';
import { createFakeDiscord } from './fakes/discord.js';
import { createFakeChroma } from './fakes/chroma.js';
import { createFakeOpenAI } from './fakes/llm.js';
import { createFakeGifs } from './fakes/gifs.js';
import { ENV, PING_CACHE, USERS } from './fixtures.js';

export const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

export const makeParts = (envOverrides = {}) => {
  const fakes = { discord: createFakeDiscord(), chroma: createFakeChroma(), llm: createFakeOpenAI(), gifs: createFakeGifs() };
  const vendor = {
    Client: fakes.discord.Client,
    ChromaClient: fakes.chroma.ChromaClient,
    OpenAIEmbeddingFunction: fakes.chroma.OpenAIEmbeddingFunction,
    OpenAI: fakes.llm.OpenAI,
    GiphyFetch: fakes.gifs.GiphyFetch,
    fetch: fakes.gifs.fetch,
  };
  const loaded = loadConfig({ ...ENV, ...envOverrides });
  const config = { ...loaded, storage: { ...loaded.storage, databasePath: ':memory:' } };
  const clock = {
    now: () => 1000, random: () => 0.5, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    clearInterval: () => {}, sleep: async () => {},
  };
  const data = { users: USERS, pingCache: PING_CACHE };
  return { fakes, vendor, config, clock, data, logger: SILENT };
};

export const buildAll = (envOverrides = {}) => {
  const base = makeParts(envOverrides);
  const storage = buildStorage(base);
  const services = buildServices({ ...base, storage });
  const discord = buildDiscord({ ...base, cacheMessages: true, given: null, storage });
  const orchestration = buildOrchestration({ ...base, storage, services, discord });
  const lifecycle = buildLifecycle({ ...base, storage, discord, exit: () => {}, closeDatabase: null });
  const backfill = buildBackfill({ ...base, storage, discord, services, lifecycle });
  return { ...base, storage, services, discord, orchestration, lifecycle, backfill };
};
