import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits, Partials } from 'discord.js';
import { createDiscordClient } from '../../../src/discord/client.js';

test('constructs the client with Guilds, GuildMessages and MessageContent intents', () => {
  const calls = [];
  class FakeClient {
    constructor(options) {
      calls.push(options);
    }
  }
  const client = createDiscordClient(FakeClient);
  assert.ok(client instanceof FakeClient);
  assert.deepEqual(calls, [{
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message],
    allowedMentions: { parse: [] },
  }]);
});

test('cacheMessages false builds the client with a message manager that caches nothing', () => {
  const calls = [];
  class FakeClient {
    constructor(options) {
      calls.push(options);
    }
  }
  createDiscordClient(FakeClient, { cacheMessages: false });
  createDiscordClient(FakeClient, { cacheMessages: true });
  assert.equal(typeof calls[0].makeCache, 'function');
  assert.equal('makeCache' in calls[1], false);
  const manager = { name: 'MessageManager' };
  const cache = calls[0].makeCache(manager, null, manager);
  assert.equal(cache.maxSize, 0);
});
