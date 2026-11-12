import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits } from 'discord.js';
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
  }]);
});
