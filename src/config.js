const buildDiscord = (env) => ({
  token: env.DISCORD_BOT_TOKEN,
  clientId: env.DISCORD_CLIENT_ID,
  channelId: env.PATEXT_CHANNEL_ID ?? '704837777564500149',
  guildId: env.GUILD_ID ?? '478743674826784769',
  botName: 'deep-pa-text',
  embedColor: 0x5865F2,
  modalTimeoutMs: 120000,
  maxMessageLength: 2000,
  truncateLookbackChars: 200,
  pingRepliedUser: env.PING_REPLIED_USER !== 'false',
});

const buildReply = (env) => ({
  probability: 0.1,
  minIntervalMs: 300000,
  escalateAfterMisses: 10,
  escalationStep: 0.05,
  override: env.REPLY_OVERRIDE === 'true',
});

const buildRevive = (env) => ({
  checkIntervalMs: 600000,
  overrideCheckIntervalMs: 60000,
  dayIdleMs: 10800000,
  nightIdleMs: 43200000,
  dayStartHour: 10,
  dayEndHour: 22,
  timeZone: 'America/Chicago',
  override: env.REVIVE_OVERRIDE === 'true',
});

const buildFilter = () => ({
  minLength: 5,
  maxLength: 200,
  commandPrefixes: ['!', '$', '#', '%', '&', '-', '+', 'p!'],
});

const buildStorage = () => ({
  databasePath: 'messages.db',
  usersPath: 'data/users.json',
  pingCachePath: 'data/ping_caches.json',
  inferredReferenceWindowMs: 3600000,
});

const parsePort = (raw) => {
  if (raw === undefined) return 7429;
  const port = raw.trim() === '' ? NaN : Number(raw);
  if (Number.isNaN(port)) throw new Error('CHROMA_PORT must be a number');
  return port;
};

const buildChroma = (env) => ({
  port: parsePort(env.CHROMA_PORT),
  messagesCollection: 'message_embeddings',
  repliesCollection: 'message_reply_embeddings',
});

const buildEmbedding = () => ({
  apiKeyEnvVar: 'OPENAI_API_KEY',
  modelName: 'text-embedding-3-small',
  dimensions: 512,
});

const buildRetrieval = () => ({
  replyResults: 10,
  similarResults: 20,
  gifResults: 10,
  otherResults: 10,
  reviveSamples: 50,
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

export const assertRetrieval = (retrieval) => {
  if (!(Number.isInteger(retrieval.overFetchFactor) && retrieval.overFetchFactor >= 1)) {
    throw new Error('retrieval.overFetchFactor must be an integer of at least 1');
  }
  const threshold = retrieval.nearDuplicateThreshold;
  if (!(Number.isFinite(threshold) && threshold > 0 && threshold <= 1)) {
    throw new Error('retrieval.nearDuplicateThreshold must be a number in (0, 1]');
  }
  return retrieval;
};

export const assertPersona = (persona) => {
  const { recencyHalfLifeMs, minRecencyWeight } = persona;
  if (!(Number.isFinite(recencyHalfLifeMs) && recencyHalfLifeMs > 0)) {
    throw new Error('persona.recencyHalfLifeMs must be a number greater than 0');
  }
  if (!(Number.isFinite(minRecencyWeight) && minRecencyWeight > 0 && minRecencyWeight <= 1)) {
    throw new Error('persona.minRecencyWeight must be a number in (0, 1]');
  }
  return persona;
};

const buildPersona = () => assertPersona({
  recencyHalfLifeMs: 15552000000,
  minRecencyWeight: 0.25,
});

const buildLlm = (env) => ({
  apiKey: env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  thinking: true,
  stream: false,
  timeoutMs: 120000,
  maxRetries: 1,
  emptyRetries: 1,
});

const buildGifs = (env) => ({
  klipyApiKey: env.KLIPY_API_KEY,
  giphyApiKey: env.GIPHY_API_KEY,
  humorApiKey: env.HUMOR_API_KEY,
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

const buildContext = () => ({
  transcriptLimit: 20,
  maxEntryChars: 300,
  maxAgeMs: 21600000,
  timeZone: 'America/Chicago',
});

const buildLogging = () => ({
  locale: 'en-US',
  timeZone: 'America/Chicago',
});

const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object') return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const buildConfig = (env) => ({
  discord: buildDiscord(env),
  reply: buildReply(env),
  revive: buildRevive(env),
  filter: buildFilter(),
  storage: buildStorage(),
  chroma: buildChroma(env),
  embedding: buildEmbedding(),
  retrieval: assertRetrieval(buildRetrieval()),
  persona: buildPersona(),
  llm: buildLlm(env),
  gifs: buildGifs(env),
  context: buildContext(),
  logging: buildLogging(),
});

export const DEFAULTS = deepFreeze(buildConfig({}));

export const loadConfig = (env = {}) => deepFreeze(buildConfig(env));
