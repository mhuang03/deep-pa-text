import { parseBoolean, parseId, parsePersonaDisplay, parsePort, readVariable } from './parse.js';

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export const buildDiscord = (env) => ({
  token: readVariable(env, 'DISCORD_BOT_TOKEN'),
  clientId: readVariable(env, 'DISCORD_CLIENT_ID'),
  channelId: parseId(env, 'PATEXT_CHANNEL_ID', '704837777564500149'),
  guildId: parseId(env, 'GUILD_ID', '478743674826784769'),
  botName: 'deep-pa-text',
  embedColor: 0x5865F2,
  modalTimeoutMs: 120000,
  maxMessageLength: 2000,
  truncateLookbackChars: 200,
  pingRepliedUser: parseBoolean(env, 'PING_REPLIED_USER', true),
  personaDisplay: parsePersonaDisplay(env, 'embed'),
  webhookName: 'deep-pa-text',
  webhookUsernameMax: 80,
  webhookReplyLink: true,
});

export const buildReply = (env) => ({
  probability: 0.1,
  minIntervalMs: 300000,
  escalateAfterMisses: 10,
  escalationStep: 0.05,
  override: parseBoolean(env, 'REPLY_OVERRIDE', false),
});

export const buildRevive = (env) => ({
  checkIntervalMs: 600000,
  overrideCheckIntervalMs: 60000,
  dayIdleMs: 10800000,
  nightIdleMs: 43200000,
  dayStartHour: 10,
  dayEndHour: 22,
  timeZone: 'America/Chicago',
  transcriptLimit: 10,
  starterGapMs: 3600000,
  starterSamples: 20,
  override: parseBoolean(env, 'REVIVE_OVERRIDE', false),
});

export const buildFilter = () => ({
  minLength: 5,
  maxLength: 200,
  commandPrefixes: ['!', '$', '#', '%', '&', '-', '+', 'p!'],
});

export const buildStorage = () => ({
  databasePath: 'messages.db',
  usersPath: 'data/users.json',
  pingCachePath: 'data/ping_caches.json',
  inferredReferenceWindowMs: 3600000,
  busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
});

export const buildChroma = (env) => ({
  port: parsePort(env, 7429),
  messagesCollection: 'message_embeddings',
  repliesCollection: 'message_reply_embeddings',
  timeoutMs: 30000,
  connectTimeoutMs: 10000,
  batchTimeoutMs: 120000,
});

export const buildEmbedding = () => ({
  apiKeyEnvVar: 'OPENAI_API_KEY',
  modelName: 'text-embedding-3-small',
  dimensions: 512,
});

export const buildRetrieval = () => ({
  replyResults: 10,
  similarResults: 20,
  gifResults: 10,
  otherResults: 10,
  reviveSamples: 30,
  likelyRepliers: 20,
  shortMessageChars: 25,
  queryContextMessages: 2,
  overFetchFactor: 3,
  nearDuplicateThreshold: 0.95,
  nearDuplicateMinChars: 12,
  frequentMinCount: 3,
  frequentLimit: 10,
  recentBotMessages: 10,
});

export const buildPersona = () => ({
  recencyHalfLifeMs: 15552000000,
  minRecencyWeight: 0.25,
});
