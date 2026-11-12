import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscord } from '../../../src/container/discord.js';
import { buildStorage } from '../../../src/container/storage.js';
import { makeParts } from '../../support/containerParts.js';

const build = (env, given = null) => {
  const parts = makeParts(env);
  const storage = buildStorage(parts);
  return { parts, storage, discord: buildDiscord({ ...parts, cacheMessages: true, given, storage }) };
};

test('returns the client and everything that reads or writes through it', () => {
  const { discord, storage } = build();
  assert.deepEqual(Object.keys(discord).sort(), [
    'botMessageResolver', 'channelHistory', 'client', 'contextBuilder', 'delivery', 'memberProfiles', 'webhooks',
  ]);
  storage.db.close();
});

test('creates the Discord client unless one is given', () => {
  const created = build();
  assert.equal(created.parts.fakes.discord.state.clientOptions.intents.length, 3);
  const given = {};
  const reused = build({}, given);
  assert.equal(reused.discord.client, given);
  assert.equal(reused.parts.fakes.discord.state.clientOptions, null);
  created.storage.db.close();
  reused.storage.db.close();
});

test('the persona display decides between the embed and the webhook delivery', async () => {
  const embed = build();
  const hook = build({ PERSONA_DISPLAY: 'webhook' });
  const guild = embed.parts.fakes.discord.state.guild;
  assert.equal((await embed.discord.delivery.placeholder({ persona: 'bob', guild })).embeds.length, 1);
  assert.equal((await hook.discord.delivery.placeholder({ persona: 'bob', guild })).content, 'Replying as bob…');
  embed.storage.db.close();
  hook.storage.db.close();
});
