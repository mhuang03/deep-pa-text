import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, isConfigError, assertBackfill, assertProfiles, assertBurst, assertChain, assertPersona, assertRetrieval, loadConfig,
  assertGifs, assertLlm, assertReply, assertFilter, assertStorage, assertLifecycle, assertCatchUp, assertChroma, assertVector,
  assertRevive, assertDiscord } from '../../src/config.js';

const EXPECTED_DEFAULTS = {
  discord: {
    token: undefined,
    clientId: undefined,
    channelId: '704837777564500149',
    guildId: '478743674826784769',
    botName: 'deep-pa-text',
    embedColor: 0x5865F2,
    modalTimeoutMs: 120000,
    maxMessageLength: 2000,
    truncateLookbackChars: 200,
    pingRepliedUser: true,
    personaDisplay: 'embed',
    webhookName: 'deep-pa-text',
    webhookUsernameMax: 80,
    webhookReplyLink: true,
    modalPreviewChars: 1000,
    maxEmbeds: 10,
  },
  reply: {
    probability: 0.1, minIntervalMs: 300000, escalateAfterMisses: 10, escalationStep: 0.05, override: false,
    failureCooldownMs: 60000,
  },
  revive: {
    checkIntervalMs: 600000, overrideCheckIntervalMs: 60000, dayIdleMs: 10800000, nightIdleMs: 43200000,
    dayStartHour: 10, dayEndHour: 22, timeZone: 'America/Chicago',
    transcriptLimit: 10, starterGapMs: 3600000, starterSamples: 20, override: false,
    failureCooldownMs: 1800000,
  },
  filter: { minLength: 5, maxLength: 200, commandPrefixes: ['!', '$', '#', '%', '&', '-', '+', 'p!'] },
  storage: {
    databasePath: 'messages.db', usersPath: 'data/users.json', pingCachePath: 'data/ping_caches.json',
    inferredReferenceWindowMs: 3600000, busyTimeoutMs: 5000, chunkSize: 500,
  },
  chroma: {
    port: 7429, messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings',
    timeoutMs: 30000, connectTimeoutMs: 10000, batchTimeoutMs: 120000,
  },
  embedding: { apiKeyEnvVar: 'OPENAI_API_KEY', apiKey: undefined, modelName: 'text-embedding-3-small', dimensions: 512 },
  retrieval: {
    replyResults: 10, similarResults: 20, gifResults: 10, otherResults: 10, reviveSamples: 30, likelyRepliers: 20,
    shortMessageChars: 25, queryContextMessages: 2,
    overFetchFactor: 3, nearDuplicateThreshold: 0.95, nearDuplicateMinChars: 12, frequentMinCount: 3,
    frequentLimit: 10, recentBotMessages: 10,
  },
  context: { transcriptLimit: 20, maxEntryChars: 300, maxAgeMs: 21600000, timeZone: 'America/Chicago' },
  chain: { enabled: true, maxContextTurns: 12, maxWalkSteps: 50,
  },
  mention: { enabled: true },
  typing: { enabled: true, refreshMs: 8000 },
  burst: {
    enabled: true, maxMessages: 3, windowMs: 30000, minRate: 0.2, minSamples: 20, cacheMs: 3600000,
    msPerChar: 40, minDelayMs: 800, maxDelayMs: 4000, siblingWindowMs: 60000,
  },
  profiles: { refreshIntervalMs: 3600000, minCheckIntervalMs: 10000, lookupTimeoutMs: 5000, searchLimit: 100 },
  backfill: { pageSize: 100, batchSize: 100, pageRetries: 3, retryDelayMs: 2000, pageTimeoutMs: 30000, comparisonPageSize: 500 },
  lifecycle: { graceMs: 10000, pollMs: 100 },
  catchUp: { enabled: true, maxMessages: 2000 },
  vector: { repairIntervalMs: 600000, repairWindowMs: 604800000 },
  persona: { recencyHalfLifeMs: 15552000000, minRecencyWeight: 0.25, missingSimilarity: 0.5 },
  llm: {
    apiKey: undefined, baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinking: true, stream: false,
    timeoutMs: 120000, maxRetries: 1, emptyRetries: 1, postProcessRetries: 1,
  },
  gifs: {
    klipyApiKey: undefined, giphyApiKey: undefined, humorApiKey: undefined, maxQueryLength: 50,
    klipyBaseUrl: 'https://api.klipy.com/api/v1', klipyPerPage: 8, klipyCustomerId: 'deep-pa-text',
    klipyLocale: 'us', klipyContentFilter: 'off', klipyFormatFilter: 'gif',
    humorUrl: 'https://api.humorapi.com/gif/search', candidates: 5, timeoutMs: 5000, maxPerMessage: 2,
  },
  topics: {
    maxMessages: 30000, recentWindowMs: 31536000000, recentShare: 0.6, sampleOverFetch: 2, minWords: 5,
    minDistinctWords: 4, minChars: 25, maxPhraseRepeats: 2, clusterDivisor: 2, minClusters: 5, maxClusters: 120,
    iterations: 15, minClusterSize: 15, minAuthors: 3, minMedianChars: 40, maxAuthorShare: 0.6, maxPrefixShare: 0.3,
    maxLabelled: 80, representatives: 20, embeddingPageSize: 500, maxLabelChars: 80, maxSummaryChars: 300,
    minTopics: 3, maxConsecutiveFailures: 3, recencyHalfLifeMs: 15552000000, recencyFloor: 0.1, maxAgeMs: 7776000000,
    conversationSamples: 8, fallbackSeeds: 6, neighbourhoodSize: 30, minNeighbours: 8,
  },
  conversation: {
    enabled: true, chance: 0.1, minIntervalMs: 86400000, minPersonas: 2, maxPersonas: 5, minMessages: 3, maxMessages: 6,
    minDelayMs: 5000, maxDelayMs: 30000, topicCandidates: 5, openerSamples: 6, avoidRecentTopics: 10,
    planRetries: 1, personaHits: 60, maxTopicChars: 80, maxPremiseChars: 300, arrangeAttempts: 50,
  },
  logging: { locale: 'en-US', timeZone: 'America/Chicago' },
};

test('defaults equal the specified table', () => {
  assert.deepEqual(loadConfig(), EXPECTED_DEFAULTS);
  assert.deepEqual(loadConfig({}), EXPECTED_DEFAULTS);
  assert.deepEqual(DEFAULTS, EXPECTED_DEFAULTS);
});

test('secrets are read from the environment', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 't', DISCORD_CLIENT_ID: 'c', DEEPSEEK_API_KEY: 'd',
    KLIPY_API_KEY: 'k', GIPHY_API_KEY: 'g', HUMOR_API_KEY: 'h',
  });
  assert.equal(config.discord.token, 't');
  assert.equal(config.discord.clientId, 'c');
  assert.equal(config.llm.apiKey, 'd');
  assert.deepEqual(
    [config.gifs.klipyApiKey, config.gifs.giphyApiKey, config.gifs.humorApiKey],
    ['k', 'g', 'h'],
  );
});

test('applies each optional environment override', () => {
  const config = loadConfig({
    PATEXT_CHANNEL_ID: '12345', GUILD_ID: '23456', CHROMA_PORT: '9000', REPLY_OVERRIDE: 'true', REVIVE_OVERRIDE: 'true',
  });
  assert.equal(config.discord.channelId, '12345');
  assert.equal(config.discord.guildId, '23456');
  assert.equal(config.chroma.port, 9000);
  assert.equal(config.reply.override, true);
  assert.equal(config.revive.override, true);
});

test('boolean overrides accept true and false in any case and reject anything else', () => {
  ['true', 'TRUE', ' True '].forEach((value) => {
    assert.equal(loadConfig({ REPLY_OVERRIDE: value }).reply.override, true, value);
  });
  ['false', 'FALSE'].forEach((value) => {
    assert.equal(loadConfig({ REVIVE_OVERRIDE: value }).revive.override, false, value);
  });
  ['1', 'yes', '0', 'on', 'off'].forEach((value) => {
    assert.throws(() => loadConfig({ REPLY_OVERRIDE: value }), (e) => isConfigError(e)
      && e.message === `REPLY_OVERRIDE must be "true" or "false", got "${value}"`);
  });
});

test('an empty or whitespace-only variable takes the default', () => {
  const config = loadConfig({
    REPLY_OVERRIDE: '', BURSTS: '  ', CHAIN_REPLIES: '', PING_REPLIED_USER: '', CHROMA_PORT: ' ',
    PATEXT_CHANNEL_ID: '', GUILD_ID: ' ', PERSONA_DISPLAY: '',
  });
  assert.deepEqual(config, DEFAULTS);
});

test('PING_REPLIED_USER, CHAIN_REPLIES and BURSTS are strict booleans', () => {
  assert.equal(loadConfig({ PING_REPLIED_USER: 'false' }).discord.pingRepliedUser, false);
  assert.equal(loadConfig({ CHAIN_REPLIES: 'FALSE' }).chain.enabled, false);
  assert.equal(loadConfig({ BURSTS: 'false' }).burst.enabled, false);
  assert.equal(loadConfig({ BURSTS: 'TRUE' }).burst.enabled, true);
  ['0', 'off', 'no'].forEach((value) => {
    ['PING_REPLIED_USER', 'CHAIN_REPLIES', 'BURSTS'].forEach((name) => {
      assert.throws(() => loadConfig({ [name]: value }), new RegExp(`${name} must be "true" or "false"`));
    });
  });
});

test('CHROMA_PORT is an integer from 1 to 65535', () => {
  assert.equal(loadConfig({ CHROMA_PORT: ' 8000 ' }).chroma.port, 8000);
  assert.equal(loadConfig({ CHROMA_PORT: '65535' }).chroma.port, 65535);
  ['abc', '0', '70000', '80.5', '0x10', '1e3', '-1', '65536'].forEach((value) => {
    assert.throws(() => loadConfig({ CHROMA_PORT: value }), (e) => isConfigError(e) && /CHROMA_PORT/.test(e.message), value);
  });
});

test('channel and guild ids must be 5 to 25 digits when set', () => {
  assert.equal(loadConfig({ GUILD_ID: '1'.repeat(25) }).discord.guildId, '1'.repeat(25));
  ['abc', '1234', '1'.repeat(26), '12a45'].forEach((value) => {
    assert.throws(() => loadConfig({ PATEXT_CHANNEL_ID: value }), /PATEXT_CHANNEL_ID/, value);
    assert.throws(() => loadConfig({ GUILD_ID: value }), /GUILD_ID/, value);
  });
});

test('secrets that are blank count as not set', () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: '  ', GIPHY_API_KEY: '', DISCORD_BOT_TOKEN: ' tok ' });
  assert.equal(config.llm.apiKey, undefined);
  assert.equal(config.gifs.giphyApiKey, undefined);
  assert.equal(config.discord.token, 'tok');
});

test('is deeply frozen, including arrays', () => {
  const config = loadConfig({});
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.reply));
  assert.ok(Object.isFrozen(config.filter.commandPrefixes));
  assert.throws(() => {
    config.reply.probability = 1;
  }, TypeError);
  assert.throws(() => config.filter.commandPrefixes.push('x'), TypeError);
});

test('does not share state between calls', () => {
  assert.notEqual(loadConfig({}), loadConfig({}));
  assert.equal(loadConfig({ GUILD_ID: '99999' }).discord.guildId, '99999');
  assert.equal(loadConfig({}).discord.guildId, '478743674826784769');
});

test('assertPersona rejects an invalid half-life or recency floor', () => {
  const valid = { recencyHalfLifeMs: 1000, minRecencyWeight: 1, missingSimilarity: 0.5 };
  assert.equal(assertPersona(valid), valid);
  [0, -1, NaN, Infinity, undefined].forEach((recencyHalfLifeMs) => {
    assert.throws(() => assertPersona({ ...valid, recencyHalfLifeMs }), /recencyHalfLifeMs/);
  });
  [0, -0.1, 1.01, NaN, undefined].forEach((minRecencyWeight) => {
    assert.throws(() => assertPersona({ ...valid, minRecencyWeight }), /minRecencyWeight/);
  });
});

test('assertRetrieval rejects an invalid over-fetch factor or near-duplicate threshold', () => {
  const valid = { ...DEFAULTS.retrieval, overFetchFactor: 1, nearDuplicateThreshold: 1 };
  assert.equal(assertRetrieval(valid), valid);
  [0, -1, 1.5, NaN, undefined].forEach((overFetchFactor) => {
    assert.throws(() => assertRetrieval({ ...valid, overFetchFactor }), /overFetchFactor/);
  });
  [0, -0.1, 1.01, NaN, undefined].forEach((nearDuplicateThreshold) => {
    assert.throws(() => assertRetrieval({ ...valid, nearDuplicateThreshold }), /nearDuplicateThreshold/);
  });
});

test('assertChain validates the context size', () => {
  const ok = { ...DEFAULTS.chain };
  assert.equal(assertChain(ok), ok);
  [1, 1.5, 0, NaN].forEach((maxContextTurns) =>
    assert.throws(() => assertChain({ ...ok, maxContextTurns }), /chain\.maxContextTurns/));
  assert.doesNotThrow(() => assertChain({ ...ok, maxContextTurns: 2 }));
});

test('assertBurst requires maxMessages to be an integer of at least 1', () => {
  const ok = { ...DEFAULTS.burst };
  assert.equal(assertBurst(ok), ok);
  [0, -1, 1.5, NaN, '3'].forEach((maxMessages) =>
    assert.throws(() => assertBurst({ ...ok, maxMessages }), /burst\.maxMessages/));
  assert.doesNotThrow(() => assertBurst({ ...ok, maxMessages: 1 }));
});

test('PERSONA_DISPLAY accepts embed and webhook and rejects anything else naming the value', () => {
  assert.equal(loadConfig({ PERSONA_DISPLAY: 'webhook' }).discord.personaDisplay, 'webhook');
  assert.equal(loadConfig({ PERSONA_DISPLAY: 'embed' }).discord.personaDisplay, 'embed');
  assert.throws(() => loadConfig({ PERSONA_DISPLAY: 'Webhook' }), /PERSONA_DISPLAY.*"Webhook"/);
  assert.throws(() => loadConfig({ PERSONA_DISPLAY: ' ' + 'x' }), /PERSONA_DISPLAY/);
});

test('assertProfiles accepts the boundaries and rejects values outside the ranges', () => {
  const ok = { refreshIntervalMs: 0, minCheckIntervalMs: 0, lookupTimeoutMs: 1, searchLimit: 1 };
  assert.deepEqual(assertProfiles(ok), ok);
  assert.equal(assertProfiles({ ...ok, searchLimit: 1000 }).searchLimit, 1000);
  const bad = [
    { refreshIntervalMs: -1 }, { refreshIntervalMs: 1.5 }, { minCheckIntervalMs: -1 },
    { minCheckIntervalMs: Number.NaN }, { lookupTimeoutMs: 0 }, { searchLimit: 0 }, { searchLimit: 1001 },
    { searchLimit: 2.5 },
  ];
  bad.forEach((override) => {
    assert.throws(() => assertProfiles({ ...ok, ...override }), /profiles\./, JSON.stringify(override));
  });
});

test('assertBackfill accepts the boundaries and rejects values outside the ranges', () => {
  const ok = { pageSize: 1, batchSize: 1, pageRetries: 0, retryDelayMs: 0, pageTimeoutMs: 1, comparisonPageSize: 1 };
  assert.deepEqual(assertBackfill(ok), ok);
  assert.equal(assertBackfill({ ...ok, pageSize: 100 }).pageSize, 100);
  const bad = [
    { pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { batchSize: 0 }, { batchSize: 2.5 },
    { pageRetries: -1 }, { pageRetries: 1.5 }, { retryDelayMs: -1 }, { retryDelayMs: Number.NaN },
    { pageTimeoutMs: 0 }, { comparisonPageSize: 0 }, { comparisonPageSize: 1.5 },
  ];
  bad.forEach((override) => {
    assert.throws(() => assertBackfill({ ...ok, ...override }), /backfill\./, JSON.stringify(override));
  });
});

const failsFor = (assertFn, valid, key, values) => values.forEach((value) => {
  assert.throws(() => assertFn({ ...valid, [key]: value }), (e) => isConfigError(e) && e.message.includes(key),
    `${key}=${String(value)}`);
});
const passesFor = (assertFn, valid, key, values) => values.forEach((value) => {
  assert.doesNotThrow(() => assertFn({ ...valid, [key]: value }), `${key}=${String(value)}`);
});

test('assertGifs requires candidates >= 1 (integer) and a positive timeout', () => {
  const ok = DEFAULTS.gifs;
  assert.equal(assertGifs(ok), ok);
  failsFor(assertGifs, ok, 'candidates', [0, 1.5, NaN, Infinity, -1, undefined]);
  failsFor(assertGifs, ok, 'timeoutMs', [0, NaN, Infinity, -1, undefined]);
  passesFor(assertGifs, ok, 'candidates', [1, 7]);
  passesFor(assertGifs, ok, 'timeoutMs', [0.5, 1]);
  failsFor(assertGifs, ok, 'maxPerMessage', [-1, 1.5, NaN, Infinity, undefined]);
  passesFor(assertGifs, ok, 'maxPerMessage', [0, 2, 10]);
});

test('assertLlm requires a positive timeout and non-negative integer retries', () => {
  const ok = DEFAULTS.llm;
  assert.equal(assertLlm(ok), ok);
  failsFor(assertLlm, ok, 'timeoutMs', [0, NaN, Infinity, -1]);
  failsFor(assertLlm, ok, 'maxRetries', [1.5, NaN, Infinity, -1]);
  failsFor(assertLlm, ok, 'emptyRetries', [1.5, NaN, Infinity, -1]);
  passesFor(assertLlm, ok, 'maxRetries', [0, 2]);
  passesFor(assertLlm, ok, 'emptyRetries', [0, 2]);
});

test('assertReply requires a probability in [0, 1] and a non-negative interval', () => {
  const ok = DEFAULTS.reply;
  assert.equal(assertReply(ok), ok);
  failsFor(assertReply, ok, 'probability', [-0.1, 1.1, NaN, Infinity, undefined]);
  failsFor(assertReply, ok, 'minIntervalMs', [-1, NaN, Infinity]);
  passesFor(assertReply, ok, 'probability', [0, 1, 0.5]);
  passesFor(assertReply, ok, 'minIntervalMs', [0, 1.5]);
});

test('assertFilter requires minLength <= maxLength', () => {
  const ok = DEFAULTS.filter;
  assert.equal(assertFilter(ok), ok);
  assert.throws(() => assertFilter({ ...ok, minLength: 10, maxLength: 9 }), /minLength/);
  assert.doesNotThrow(() => assertFilter({ ...ok, minLength: 9, maxLength: 9 }));
  failsFor(assertFilter, ok, 'minLength', [NaN, -1]);
  failsFor(assertFilter, ok, 'maxLength', [NaN, Infinity]);
});

test('assertRetrieval requires every result count to be an integer of at least 1', () => {
  const ok = DEFAULTS.retrieval;
  ['replyResults', 'similarResults', 'gifResults', 'otherResults', 'reviveSamples', 'likelyRepliers'].forEach((key) => {
    failsFor(assertRetrieval, ok, key, [0, 1.5, NaN, Infinity, undefined]);
    passesFor(assertRetrieval, ok, key, [1, 50]);
  });
});

test('assertStorage requires a non-negative integer busy timeout', () => {
  const ok = DEFAULTS.storage;
  assert.equal(assertStorage(ok), ok);
  failsFor(assertStorage, ok, 'busyTimeoutMs', [-1, 1.5, NaN, Infinity, undefined]);
  passesFor(assertStorage, ok, 'busyTimeoutMs', [0, 5000]);
  failsFor(assertStorage, ok, 'chunkSize', [0, 1.5, NaN, undefined]);
  passesFor(assertStorage, ok, 'chunkSize', [1, 500]);
});

test('every validator error is a config error', () => {
  assert.throws(() => assertGifs({ ...DEFAULTS.gifs, candidates: 0 }), (e) => isConfigError(e) && e instanceof Error);
  assert.equal(isConfigError(new Error('x')), false);
  assert.equal(isConfigError(undefined), false);
});

test('assertLifecycle and assertCatchUp validate their ranges', () => {
  assert.deepEqual(assertLifecycle({ graceMs: 0, pollMs: 1 }), { graceMs: 0, pollMs: 1 });
  [{ graceMs: -1 }, { pollMs: 0 }, { pollMs: Number.NaN }].forEach((override) => {
    assert.throws(() => assertLifecycle({ graceMs: 1, pollMs: 1, ...override }), /lifecycle\./);
  });
  assert.equal(assertCatchUp({ enabled: true, maxMessages: 1 }).maxMessages, 1);
  [0, 1.5, -3].forEach((maxMessages) => {
    assert.throws(() => assertCatchUp({ enabled: true, maxMessages }), /catchUp\.maxMessages/);
  });
});

test('CATCH_UP is a strict boolean that defaults to on', () => {
  assert.equal(loadConfig({}).catchUp.enabled, true);
  assert.equal(loadConfig({ CATCH_UP: 'false' }).catchUp.enabled, false);
  assert.throws(() => loadConfig({ CATCH_UP: 'maybe' }), /CATCH_UP must be/);
});

test('assertChroma requires positive timeouts', () => {
  const ok = DEFAULTS.chroma;
  ['timeoutMs', 'connectTimeoutMs', 'batchTimeoutMs'].forEach((key) => {
    failsFor(assertChroma, ok, key, [0, -1, Number.NaN, undefined]);
    passesFor(assertChroma, ok, key, [1, 50]);
  });
});

test('assertVector requires a positive repair interval and window', () => {
  const ok = DEFAULTS.vector;
  ['repairIntervalMs', 'repairWindowMs'].forEach((key) => {
    failsFor(assertVector, ok, key, [0, -1, Number.NaN, undefined]);
    passesFor(assertVector, ok, key, [1, 604800000]);
  });
});

test('assertReply and assertRevive require a non-negative failure cooldown', () => {
  const reply = loadConfig({}).reply;
  failsFor(assertReply, reply, 'failureCooldownMs', [-1, NaN, Infinity, undefined]);
  passesFor(assertReply, reply, 'failureCooldownMs', [0, 60000]);
  const revive = loadConfig({}).revive;
  failsFor(assertRevive, revive, 'failureCooldownMs', [-1, NaN, Infinity, undefined]);
  passesFor(assertRevive, revive, 'failureCooldownMs', [0, 1800000]);
});

test('manual engagement has no limit keys: chain keeps only its shape, and there is no command section', () => {
  const config = loadConfig({});
  assert.deepEqual(Object.keys(config.chain).sort(), ['enabled', 'maxContextTurns', 'maxWalkSteps']);
  assert.equal(config.command, undefined);
});

test('MENTION_REPLIES is a strict boolean that defaults to on', () => {
  assert.equal(loadConfig({}).mention.enabled, true);
  assert.equal(loadConfig({ MENTION_REPLIES: 'false' }).mention.enabled, false);
  assert.throws(() => loadConfig({ MENTION_REPLIES: 'off' }), /MENTION_REPLIES/);
});

test('assertDiscord requires a non-negative integer preview length and assertLlm the post-process retries', () => {
  const discord = loadConfig({}).discord;
  failsFor(assertDiscord, discord, 'modalPreviewChars', [-1, 1.5, NaN, Infinity]);
  passesFor(assertDiscord, discord, 'modalPreviewChars', [0, 1000]);
  failsFor(assertDiscord, discord, 'maxEmbeds', [0, -1, 1.5, NaN, Infinity, undefined]);
  passesFor(assertDiscord, discord, 'maxEmbeds', [1, 10]);
  failsFor(assertLlm, loadConfig({}).llm, 'postProcessRetries', [-1, 1.5, NaN]);
  passesFor(assertLlm, loadConfig({}).llm, 'postProcessRetries', [0, 2]);
});
