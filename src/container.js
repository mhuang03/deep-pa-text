// The only place services are wired together.
import { createConfigError } from './config/errors.js';
import { buildUserDirectory } from './userData/loadData.js';
import { createMessageFilter } from './corpus/messageFilter.js';
import { openDatabase } from './storage/database.js';
import { createMessageStore } from './storage/messageStore.js';
import { createBotMessageStore } from './storage/botMessageStore.js';
import { createProfileStore } from './storage/profileStore.js';
import { createMetaStore } from './storage/metaStore.js';
import { createVectorStore } from './storage/vectorStore.js';
import { createIngestService } from './ingest/ingestService.js';
import { createBurstProfile } from './retrieval/burstProfile.js';
import { createRetriever } from './retrieval/retriever.js';
import { createPersonaSelector } from './retrieval/personaSelector.js';
import { createChannelHistory } from './discord/channelHistory.js';
import { createContextBuilder } from './context/contextBuilder.js';
import { createChatClient } from './llm/chatClient.js';
import { createGenerator } from './llm/generator.js';
import { createKlipyEngine, createGiphyEngine, createHumorEngine } from './gifs/engines.js';
import { createGifResolver } from './gifs/gifResolver.js';
import { createDiscordClient } from './discord/client.js';
import { createAuthorEmbeds } from './discord/authorEmbed.js';
import { createEmbedDelivery } from './discord/delivery.js';
import { fetchMember } from './discord/memberLookup.js';
import { createWebhookProvider } from './discord/webhooks.js';
import { createWebhookDelivery } from './discord/webhookDelivery.js';
import { createMemberProfiles } from './profiles/memberProfiles.js';
import { createActivityTracker } from './bot/activityTracker.js';
import { createReplyPolicy } from './bot/replyPolicy.js';
import { createChainPolicy } from './bot/chainPolicy.js';
import { createCommandLimiter } from './bot/commandLimiter.js';
import { createChainBuilder } from './context/chainBuilder.js';
import { createComposer } from './bot/composer.js';
import { createBotMessageResolver } from './bot/botMessageResolver.js';
import { createResponder } from './bot/responder.js';
import { createMessageDeleteHandler } from './bot/handlers/messageDelete.js';
import { createMessageUpdateHandler } from './bot/handlers/messageUpdate.js';
import { createMessageCreateHandler } from './bot/handlers/messageCreate.js';
import { createReplyCommandHandler } from './bot/handlers/replyCommand.js';
import { createReviveTick } from './bot/handlers/reviveTick.js';
import { createProfileRefresh } from './bot/handlers/profileRefresh.js';
import { createBot } from './bot/bot.js';
import { createLifecycle } from './bot/lifecycle.js';
import { restoreState } from './bot/stateRestore.js';
import { createCatchUp } from './backfill/catchUp.js';
import { createHistoryReader } from './backfill/historyReader.js';
import { createBotMessageImporter } from './backfill/botMessageImporter.js';
import { createHistoryImporter } from './backfill/historyImporter.js';
import { createVectorSync } from './ingest/vectorSync.js';
import { createVectorHealth } from './ingest/vectorHealth.js';

export const GENERATION_KEY = 'chroma_generation';

// Lazy wrappers: global mocks of Date, Math.random and setInterval are honoured at call time.
export const defaultClock = () => {
  const clock = {
    now: () => Date.now(),
    random: () => Math.random(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    clearInterval: (handle) => clearInterval(handle),
    sleep: (ms) => new Promise((resolve) => { clock.setTimeout(resolve, ms); }),
  };
  return clock;
};

// Only engines whose key is set are built, so a missing key never produces a request.
const buildGifEngines = ({ config, vendor }) => {
  const { klipyApiKey, giphyApiKey, humorApiKey } = config.gifs;
  return [
    klipyApiKey && createKlipyEngine({ fetch: vendor.fetch, config }),
    giphyApiKey && createGiphyEngine({ giphy: new vendor.GiphyFetch(giphyApiKey), config }),
    humorApiKey && createHumorEngine({ fetch: vendor.fetch, config }),
  ].filter(Boolean);
};

export const buildGifResolver = ({ config, vendor, clock = defaultClock(), logger }) => {
  const engines = buildGifEngines({ config, vendor });
  return createGifResolver({ engines, config, random: clock.random, logger, clock });
};

const buildVectorStore = ({ config, vendor, generation, clock }) => {
  const { chroma, embedding } = config;
  const client = new vendor.ChromaClient({ port: chroma.port });
  const embeddingFunction = new vendor.OpenAIEmbeddingFunction({
    apiKeyEnvVar: embedding.apiKeyEnvVar,
    modelName: embedding.modelName,
    dimensions: embedding.dimensions,
  });
  return createVectorStore({ client, embeddingFunction, config, generation, clock });
};

// Without a key the SDK would fall back to OPENAI_API_KEY and send it to DeepSeek, so it is never constructed.
const buildChatClient = ({ config, vendor }) => {
  const { apiKey, baseURL, timeoutMs, maxRetries } = config.llm;
  if (!apiKey) {
    return {
      complete: async () => {
        throw createConfigError('DEEPSEEK_API_KEY is not set, so no reply can be generated.');
      },
    };
  }
  const client = new vendor.OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries });
  return createChatClient({ client, config });
};

const buildGenerator = ({
  config, vendor, retriever, userDirectory, botMessageStore, messageStore, burstProfile, logger,
}) => {
  const chatClient = buildChatClient({ config, vendor });
  return createGenerator({
    chatClient, retriever, userDirectory, botMessageStore, messageStore, burstProfile, config, logger,
  });
};

const buildCore = ({ config, vendor, data, clock, logger }) => {
  const db = openDatabase(config.storage.databasePath, { busyTimeoutMs: config.storage.busyTimeoutMs });
  const messageStore = createMessageStore({ db, config });
  const botMessageStore = createBotMessageStore({ db, config });
  const profileStore = createProfileStore({ db });
  const metaStore = createMetaStore({ db });
  const vectorStore = buildVectorStore({ config, vendor, generation: metaStore.get(GENERATION_KEY), clock });
  const messageFilter = createMessageFilter({ users: data.users, pingCache: data.pingCache, config });
  const vectorSync = createVectorSync({ messageStore, vectorStore, logger, config });
  const vectorHealth = createVectorHealth({ vectorSync, clock, config, logger });
  const ingest = createIngestService({
    messageStore, vectorStore, messageFilter, botMessageStore, onVectorError: vectorHealth.noteFailure,
  });
  const retriever = createRetriever({ vectorStore, messageStore, config, logger });
  const userDirectory = buildUserDirectory(data.users);
  const personaSelector = createPersonaSelector({
    vectorStore, messageStore, users: data.users, random: clock.random, config,
  });
  const burstProfile = createBurstProfile({ messageStore, config, now: clock.now });
  const generator = buildGenerator({
    config, vendor, retriever, userDirectory, botMessageStore, messageStore, burstProfile, logger,
  });
  return {
    db, messageStore, botMessageStore, profileStore, metaStore, vectorStore, vectorSync, vectorHealth, messageFilter,
    ingest, retriever, userDirectory, personaSelector, burstProfile, generator,
  };
};

const buildHandlers = ({
  config, data, clock, logger, client, core, responder, delivery, memberProfiles,
  botMessageResolver, chainBuilder, activity, replyPolicy,
}) => {
  const chainPolicy = createChainPolicy({ config, random: clock.random, now: clock.now });
  const commandLimiter = createCommandLimiter({ config, now: clock.now });
  const { ingest, messageFilter, personaSelector, botMessageStore, messageStore } = core;
  const deleteHandler = createMessageDeleteHandler({ config, ingest, clock, logger });
  return {
    messageDelete: deleteHandler.onDelete,
    messageBulkDelete: deleteHandler.onBulkDelete,
    messageUpdate: createMessageUpdateHandler({
      config, ingest, botMessageStore, clock: { now: clock.now }, logger,
    }).onUpdate,
    messageCreate: createMessageCreateHandler({
      config, activity, ingest, messageFilter, replyPolicy, personaSelector, responder, logger,
      botMessageStore, messageStore, botMessageResolver, chainBuilder, chainPolicy,
    }),
    replyCommand: createReplyCommandHandler({
      client, config, users: data.users, messageFilter, personaSelector, responder,
      delivery, replyPolicy, botMessageResolver, commandLimiter, logger,
    }),
    profileRefresh: createProfileRefresh({ client, config, memberProfiles, logger }),
    reviveTick: createReviveTick({
      client, config, activity, personaSelector, responder, clock: { now: clock.now }, logger,
    }),
  };
};

const buildDelivery = ({ config, client, memberProfiles, logger }) => {
  const authorEmbeds = createAuthorEmbeds({ config, memberProfiles });
  const embedDelivery = createEmbedDelivery({ authorEmbeds, config });
  const webhooks = createWebhookProvider({ getBotUserId: () => client.user?.id, config });
  if (config.discord.personaDisplay !== 'webhook') return { delivery: embedDelivery, webhooks };
  const delivery = createWebhookDelivery({
    webhooks, memberProfiles, fallback: embedDelivery, config, logger,
  });
  return { delivery, webhooks };
};

const buildBackfill = ({ config, clock, logger, client, core, channelHistory, webhooks }) => {
  const { messageStore, botMessageStore, profileStore, userDirectory, messageFilter, ingest } = core;
  const historyReader = createHistoryReader({ channelHistory, config, clock, logger });
  const botMessageImporter = createBotMessageImporter({
    botMessageStore, profileStore, userDirectory, config, logger,
  });
  const historyImporter = createHistoryImporter({
    historyReader, botMessageImporter, ingest, messageStore, botMessageStore, messageFilter, webhooks,
    getBotUserId: () => client.user?.id, config, logger,
  });
  return { historyReader, botMessageImporter, historyImporter };
};

const buildStartupTasks = ({ core, activity, replyPolicy, catchUp, clock }) => ({
  restoreState: ({ capped = false } = {}) => restoreState({
    messageStore: core.messageStore, botMessageStore: core.botMessageStore, activity, replyPolicy,
    now: clock.now, capped,
  }),
  catchUp: catchUp.run,
});

export const buildContainer = ({
  config, vendor, data, clock = defaultClock(), logger, cacheMessages = true, client: given = null,
  exit = () => {}, closeDatabase = null,
}) => {
  const core = buildCore({ config, vendor, data, clock, logger });
  const client = given ?? createDiscordClient(vendor.Client, { cacheMessages });
  const gifResolver = buildGifResolver({ config, vendor, clock, logger });
  const composer = createComposer({ generator: core.generator, gifResolver, config });
  const { botMessageStore, userDirectory, profileStore } = core;
  const memberProfiles = createMemberProfiles({
    profileStore, fetchMember, userDirectory, config, clock, logger,
  });
  const { delivery, webhooks } = buildDelivery({ config, client, memberProfiles, logger });
  const botMessageResolver = createBotMessageResolver({
    botMessageStore, userDirectory, getBotUserId: () => client.user?.id,
  });
  const channelHistory = createChannelHistory({ logger });
  const contextBuilder = createContextBuilder({
    channelHistory, botMessageResolver, messageFilter: core.messageFilter, config,
  });
  const responder = createResponder({
    composer, delivery, contextBuilder, botMessageStore, clock, config, logger,
  });
  const chainBuilder = createChainBuilder({
    botMessageStore, messageStore: core.messageStore, messageFilter: core.messageFilter, userDirectory, config,
  });
  const activity = createActivityTracker({ now: clock.now });
  const replyPolicy = createReplyPolicy({ config, now: clock.now, random: clock.random });
  const handlers = buildHandlers({
    config, data, clock, logger, client, core, responder, delivery, memberProfiles,
    botMessageResolver, chainBuilder, activity, replyPolicy,
  });
  const lifecycle = createLifecycle({
    client, closeDatabase: closeDatabase ?? (() => core.db.close()), clock, logger, exit, config,
  });
  const backfill = buildBackfill({ config, clock, logger, client, core, channelHistory, webhooks });
  const catchUp = createCatchUp({
    channelHistory, historyImporter: backfill.historyImporter, messageStore: core.messageStore,
    lifecycle, clock, config, logger,
  });
  const startupTasks = buildStartupTasks({ core, activity, replyPolicy, catchUp, clock });
  const bot = createBot({
    client, config, handlers, lifecycle, startupTasks, vectorHealth: core.vectorHealth, logger,
  });
  return {
    bot, lifecycle, client, logger, gifResolver, composer, delivery, responder, botMessageResolver, contextBuilder,
    chainBuilder, memberProfiles, webhooks, ...backfill, ...core,
  };
};
