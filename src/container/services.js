import { createConfigError } from '../config/errors.js';
import { createIngestService } from '../ingest/ingestService.js';
import { createVectorSync } from '../ingest/vectorSync.js';
import { createVectorHealth } from '../ingest/vectorHealth.js';
import { createBurstProfile } from '../retrieval/burstProfile.js';
import { createRetriever } from '../retrieval/retriever.js';
import { createPersonaSelector } from '../retrieval/personaSelector.js';
import { createChatClient } from '../llm/chatClient.js';
import { createGenerator } from '../llm/generator.js';
import { createKlipyEngine, createGiphyEngine, createHumorEngine } from '../gifs/engines.js';
import { createGifResolver } from '../gifs/gifResolver.js';
import { createComposer } from '../bot/composer.js';
import { defaultClock } from './clock.js';

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

const buildVectorServices = ({ config, clock, logger, storage }) => {
  const { messageStore, vectorStore, messageFilter, botMessageStore } = storage;
  const vectorSync = createVectorSync({ messageStore, vectorStore, logger, config });
  const vectorHealth = createVectorHealth({ vectorSync, clock, config, logger });
  const ingest = createIngestService({
    messageStore, vectorStore, messageFilter, botMessageStore, onVectorError: vectorHealth.noteFailure,
  });
  return { vectorSync, vectorHealth, ingest };
};

const buildGeneration = ({ config, vendor, clock, logger, storage }) => {
  const { vectorStore, messageStore, botMessageStore, userDirectory } = storage;
  const retriever = createRetriever({ vectorStore, messageStore, config, logger });
  const burstProfile = createBurstProfile({ messageStore, config, now: clock.now });
  const generator = createGenerator({
    chatClient: buildChatClient({ config, vendor }),
    retriever, userDirectory, botMessageStore, messageStore, burstProfile, config, logger,
  });
  return { retriever, burstProfile, generator };
};

// Use-case services built on the storage adapters: ingest, retrieval, generation and GIFs.
export const buildServices = ({ config, vendor, data, clock, logger, storage }) => {
  const generation = buildGeneration({ config, vendor, clock, logger, storage });
  const personaSelector = createPersonaSelector({
    vectorStore: storage.vectorStore, messageStore: storage.messageStore, users: data.users, random: clock.random, config,
  });
  const gifResolver = buildGifResolver({ config, vendor, clock, logger });
  const composer = createComposer({ generator: generation.generator, gifResolver, config });
  return {
    ...buildVectorServices({ config, clock, logger, storage }), ...generation, personaSelector, gifResolver, composer,
  };
};
