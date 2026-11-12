import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loadConfig } from '../../src/config.js';

const EXPECTED_DEFAULTS = {
  discord: {
    token: undefined,
    clientId: undefined,
    channelId: '704837777564500149',
    guildId: '478743674826784769',
    botName: 'deep-pa-text',
    embedColor: 0x5865F2,
    modalTimeoutMs: 120000,
  },
  reply: {
    probability: 0.1, minIntervalMs: 300000, escalateAfterMisses: 10, escalationStep: 0.05, override: false,
  },
  revive: {
    checkIntervalMs: 600000, overrideCheckIntervalMs: 60000, dayIdleMs: 10800000, nightIdleMs: 43200000,
    dayStartHour: 10, dayEndHour: 22, timeZone: 'America/Chicago', override: false,
  },
  filter: { minLength: 5, maxLength: 200, commandPrefixes: ['!', '$', '#', '%', '&', '-', '+', 'p!'] },
  storage: {
    databasePath: 'messages.db', usersPath: 'data/users.json', pingCachePath: 'data/ping_caches.json',
    inferredReferenceWindowMs: 3600000,
  },
  chroma: { port: 7429, messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings' },
  embedding: { apiKeyEnvVar: 'OPENAI_API_KEY', modelName: 'text-embedding-3-small', dimensions: 512 },
  retrieval: {
    replyResults: 10, similarResults: 20, gifResults: 10, otherResults: 10, reviveSamples: 50, likelyRepliers: 20,
  },
  llm: {
    apiKey: undefined, baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinking: true, stream: false,
  },
  gifs: {
    klipyApiKey: undefined, giphyApiKey: undefined, humorApiKey: undefined, maxQueryLength: 50,
    klipyBaseUrl: 'https://api.klipy.com/api/v1', klipyPerPage: 8, klipyCustomerId: 'deep-pa-text',
    klipyLocale: 'us', klipyContentFilter: 'off', klipyFormatFilter: 'gif',
    humorUrl: 'https://api.humorapi.com/gif/search', humorNumber: 1, giphyLimit: 1,
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
    PATEXT_CHANNEL_ID: '1', GUILD_ID: '2', CHROMA_PORT: '9000', REPLY_OVERRIDE: 'true', REVIVE_OVERRIDE: 'true',
  });
  assert.equal(config.discord.channelId, '1');
  assert.equal(config.discord.guildId, '2');
  assert.equal(config.chroma.port, 9000);
  assert.equal(config.reply.override, true);
  assert.equal(config.revive.override, true);
});

test('boolean overrides are true only for the string true', () => {
  ['TRUE', '1', 'yes', 'false', ''].forEach((value) => {
    const config = loadConfig({ REPLY_OVERRIDE: value, REVIVE_OVERRIDE: value });
    assert.equal(config.reply.override, false, value);
    assert.equal(config.revive.override, false, value);
  });
});

test('throws when CHROMA_PORT is not a number', () => {
  assert.throws(() => loadConfig({ CHROMA_PORT: 'abc' }), { message: 'CHROMA_PORT must be a number' });
  assert.throws(() => loadConfig({ CHROMA_PORT: '' }), { message: 'CHROMA_PORT must be a number' });
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
  assert.equal(loadConfig({ GUILD_ID: 'x' }).discord.guildId, 'x');
  assert.equal(loadConfig({}).discord.guildId, '478743674826784769');
});
