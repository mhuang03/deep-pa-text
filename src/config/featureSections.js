import { parseBoolean, readVariable } from './parse.js';

export const buildLlm = (env) => ({
  apiKey: readVariable(env, 'DEEPSEEK_API_KEY'),
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  thinking: true,
  stream: false,
  timeoutMs: 120000,
  maxRetries: 1,
  emptyRetries: 1,
});

export const buildGifs = (env) => ({
  klipyApiKey: readVariable(env, 'KLIPY_API_KEY'),
  giphyApiKey: readVariable(env, 'GIPHY_API_KEY'),
  humorApiKey: readVariable(env, 'HUMOR_API_KEY'),
  maxQueryLength: 50,
  klipyBaseUrl: 'https://api.klipy.com/api/v1',
  klipyPerPage: 8,
  klipyCustomerId: 'deep-pa-text',
  klipyLocale: 'us',
  klipyContentFilter: 'off',
  klipyFormatFilter: 'gif',
  humorUrl: 'https://api.humorapi.com/gif/search',
  candidates: 5,
  timeoutMs: 5000,
});

export const buildContext = () => ({
  transcriptLimit: 20,
  maxEntryChars: 300,
  maxAgeMs: 21600000,
  timeZone: 'America/Chicago',
});

export const buildChain = (env) => ({
  enabled: parseBoolean(env, 'CHAIN_REPLIES', true),
  fullDepth: 3,
  decay: 0.5,
  maxBotTurns: 8,
  maxContextTurns: 12,
  maxWalkSteps: 50,
});

export const buildTyping = () => ({
  enabled: true,
  refreshMs: 8000,
});

export const buildBurst = (env) => ({
  enabled: parseBoolean(env, 'BURSTS', true),
  maxMessages: 3,
  windowMs: 30000,
  minRate: 0.2,
  minSamples: 20,
  cacheMs: 3600000,
  msPerChar: 40,
  minDelayMs: 800,
  maxDelayMs: 4000,
  siblingWindowMs: 60000,
});

export const buildProfiles = () => ({
  refreshIntervalMs: 3600000,
  minCheckIntervalMs: 10000,
  lookupTimeoutMs: 5000,
  searchLimit: 100,
});

export const buildBackfill = () => ({
  pageSize: 100,
  batchSize: 100,
  pageRetries: 3,
  retryDelayMs: 2000,
  pageTimeoutMs: 30000,
});

export const buildLogging = () => ({
  locale: 'en-US',
  timeZone: 'America/Chicago',
});
