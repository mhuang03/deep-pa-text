// The only place services are wired together.
import { createLogger } from './logger.js';
import { buildUserDirectory } from './userData/loadData.js';
import { createMessageFilter } from './corpus/messageFilter.js';
import { openDatabase } from './storage/database.js';
import { createMessageStore } from './storage/messageStore.js';
import { createVectorStore } from './storage/vectorStore.js';
import { createIngestService } from './ingest/ingestService.js';
import { createRetriever } from './retrieval/retriever.js';
import { createPersonaSelector } from './retrieval/personaSelector.js';
import { createChatClient } from './llm/chatClient.js';
import { createGenerator } from './llm/generator.js';
import { createKlipyEngine, createGiphyEngine, createHumorEngine } from './gifs/engines.js';
import { createGifResolver } from './gifs/gifResolver.js';
import { createDiscordClient } from './discord/client.js';
import { createAuthorEmbeds } from './discord/authorEmbed.js';
import { createEmbedDelivery } from './discord/delivery.js';
import { createActivityTracker } from './bot/activityTracker.js';
import { createReplyPolicy } from './bot/replyPolicy.js';
import { createComposer } from './bot/composer.js';
import { createResponder } from './bot/responder.js';
import { createMessageCreateHandler } from './bot/handlers/messageCreate.js';
import { createReplyCommandHandler } from './bot/handlers/replyCommand.js';
import { createReviveTick } from './bot/handlers/reviveTick.js';
import { createBot } from './bot/bot.js';

// Lazy wrappers: global mocks of Date, Math.random and setInterval are honoured at call time.
export const defaultClock = () => ({
  now: () => Date.now(),
  random: () => Math.random(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

export const buildGifResolver = ({ config, vendor, clock = defaultClock(), logger = createLogger() }) => {
  const giphy = new vendor.GiphyFetch(config.gifs.giphyApiKey);
  const engines = [
    createKlipyEngine({ fetch: vendor.fetch, config }),
    createGiphyEngine({ giphy, config }),
    createHumorEngine({ fetch: vendor.fetch, config }),
  ];
  return createGifResolver({ engines, config, random: clock.random, logger, clock });
};

const buildVectorStore = ({ config, vendor }) => {
  const { chroma, embedding } = config;
  const client = new vendor.ChromaClient({ port: chroma.port });
  const embeddingFunction = new vendor.OpenAIEmbeddingFunction({
    apiKeyEnvVar: embedding.apiKeyEnvVar,
    modelName: embedding.modelName,
    dimensions: embedding.dimensions,
  });
  return createVectorStore({ client, embeddingFunction, config });
};

const buildGenerator = ({ config, vendor, retriever, userDirectory }) => {
  const { apiKey, baseURL, timeoutMs, maxRetries } = config.llm;
  const client = new vendor.OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries });
  const chatClient = createChatClient({ client, config });
  return createGenerator({ chatClient, retriever, userDirectory });
};

const buildCore = ({ config, vendor, data, clock }) => {
  const db = openDatabase(config.storage.databasePath);
  const messageStore = createMessageStore({ db, config });
  const vectorStore = buildVectorStore({ config, vendor });
  const messageFilter = createMessageFilter({ users: data.users, pingCache: data.pingCache, config });
  const ingest = createIngestService({ messageStore, vectorStore, messageFilter });
  const retriever = createRetriever({ vectorStore, messageStore, config });
  const userDirectory = buildUserDirectory(data.users);
  const personaSelector = createPersonaSelector({
    vectorStore, users: data.users, random: clock.random, config,
  });
  const generator = buildGenerator({ config, vendor, retriever, userDirectory });
  return {
    db, messageStore, vectorStore, messageFilter, ingest, retriever, userDirectory,
    personaSelector, generator,
  };
};

const buildHandlers = ({ config, data, clock, logger, client, core, responder, authorEmbeds }) => {
  const activity = createActivityTracker({ now: clock.now });
  const replyPolicy = createReplyPolicy({ config, now: clock.now, random: clock.random });
  const { ingest, messageFilter, personaSelector } = core;
  return {
    messageCreate: createMessageCreateHandler({
      config, activity, ingest, messageFilter, replyPolicy, personaSelector, responder, logger,
    }),
    replyCommand: createReplyCommandHandler({
      client, config, users: data.users, messageFilter, personaSelector, responder,
      authorEmbeds, replyPolicy, activity, logger,
    }),
    reviveTick: createReviveTick({
      client, config, activity, personaSelector, responder, clock: { now: clock.now }, logger,
    }),
  };
};

export const buildContainer = ({
  config, vendor, data, clock = defaultClock(), logger = createLogger(),
}) => {
  const core = buildCore({ config, vendor, data, clock });
  const client = createDiscordClient(vendor.Client);
  const gifResolver = buildGifResolver({ config, vendor, clock, logger });
  const authorEmbeds = createAuthorEmbeds({ config, logger });
  const composer = createComposer({ generator: core.generator, gifResolver, config });
  const delivery = createEmbedDelivery({ authorEmbeds, config });
  const responder = createResponder({ composer, delivery, logger });
  const handlers = buildHandlers({ config, data, clock, logger, client, core, responder, authorEmbeds });
  const bot = createBot({ client, config, handlers, clock, logger });
  return { bot, client, logger, gifResolver, composer, delivery, responder, ...core };
};
