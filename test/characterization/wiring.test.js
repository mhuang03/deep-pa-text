import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits } from 'discord.js';
import { createWorld } from '../support/world.js';

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

test('constructs the Discord client with the guild, message and message-content intents', async (t) => {
  const world = await newWorld(t);
  const intents = [...world.discord.clientOptions.intents];
  assert.equal(intents.length, 3);
  assert.deepEqual(
    new Set(intents),
    new Set([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]),
  );
});

test('logs in once with the Discord bot token', async (t) => {
  const world = await newWorld(t);
  assert.deepEqual(world.discord.loginTokens, [world.env.DISCORD_BOT_TOKEN]);
});

test('constructs an OpenAI-compatible client with the DeepSeek key and base URL', async (t) => {
  const world = await newWorld(t);
  const match = world.llm.constructed.filter(
    (options) => options.apiKey === world.env.DEEPSEEK_API_KEY && options.baseURL === 'https://api.deepseek.com',
  );
  assert.equal(match.length, 1);
});

test('sends every chat request through the DeepSeek client', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.subject.getRandomResponse('alice');
  await world.emitMessage({ content: 'hello there friends' });
  assert.ok(world.llm.calls.length >= 2);
  assert.equal(world.llm.callClients.length, world.llm.calls.length);
  for (const client of world.llm.callClients) {
    assert.equal(client.apiKey, world.env.DEEPSEEK_API_KEY);
    assert.equal(client.baseURL, 'https://api.deepseek.com');
  }
});

test('constructs GiphyFetch with the Giphy API key', async (t) => {
  const world = await newWorld(t);
  assert.deepEqual(world.gifs.constructed, [[world.env.GIPHY_API_KEY]]);
});
