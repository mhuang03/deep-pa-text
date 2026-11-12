import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sections from '../../../src/config/sections.js';

test('buildDiscord reads the token, client id and overrides from the environment', () => {
  const discord = sections.buildDiscord({
    DISCORD_BOT_TOKEN: ' tok ', DISCORD_CLIENT_ID: '99999', PATEXT_CHANNEL_ID: '11111', GUILD_ID: '22222',
    PING_REPLIED_USER: 'false', PERSONA_DISPLAY: 'webhook',
  });
  assert.deepEqual(
    [discord.token, discord.clientId, discord.channelId, discord.guildId, discord.pingRepliedUser, discord.personaDisplay],
    ['tok', '99999', '11111', '22222', false, 'webhook'],
  );
});

test('buildDiscord falls back to the original deployment ids', () => {
  const discord = sections.buildDiscord({});
  assert.equal(discord.channelId, '704837777564500149');
  assert.equal(discord.guildId, '478743674826784769');
  assert.equal(discord.personaDisplay, 'embed');
});

test('buildReply and buildRevive read their override flags', () => {
  assert.equal(sections.buildReply({ REPLY_OVERRIDE: 'true' }).override, true);
  assert.equal(sections.buildReply({}).override, false);
  assert.equal(sections.buildRevive({ REVIVE_OVERRIDE: 'true' }).override, true);
});

test('buildStorage holds the chunk size and busy timeout', () => {
  const storage = sections.buildStorage();
  assert.equal(storage.chunkSize, 500);
  assert.equal(storage.busyTimeoutMs, sections.DEFAULT_BUSY_TIMEOUT_MS);
});

test('buildChroma takes the port from the environment; buildEmbedding keeps the key variable name', () => {
  assert.equal(sections.buildChroma({ CHROMA_PORT: '9000' }).port, 9000);
  assert.equal(sections.buildChroma({}).port, 7429);
  const embedding = sections.buildEmbedding({ OPENAI_API_KEY: 'k' });
  assert.deepEqual([embedding.apiKeyEnvVar, embedding.apiKey], ['OPENAI_API_KEY', 'k']);
});

test('buildPersona carries the missing-similarity weight', () => {
  assert.deepEqual(sections.buildPersona(), { recencyHalfLifeMs: 15552000000, minRecencyWeight: 0.25, missingSimilarity: 0.5 });
});

test('buildFilter and buildRetrieval return fresh objects', () => {
  assert.notEqual(sections.buildFilter(), sections.buildFilter());
  assert.equal(sections.buildRetrieval().overFetchFactor, 3);
});
