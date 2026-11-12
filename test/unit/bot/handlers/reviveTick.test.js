import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviveTick } from '../../../../src/bot/handlers/reviveTick.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';
import { BASE_TIME } from '../../../support/fixtures.js';

const HOUR = 3600000;

const setup = ({ env = {}, activity = { lastMessageTime: BASE_TIME - 4 * HOUR, lastWasBot: false }, failCompose = false } = {}) => {
  const events = [];
  const logs = { info: [], error: [] };
  const discord = createFakeDiscord();
  const client = {
    channels: { fetch: async (id) => (events.push(['fetch', id]), discord.state.channel) },
    guilds: { fetch: async (id) => (events.push(['guildFetch', id]), discord.state.guild) },
  };
  const deps = {
    client,
    config: loadConfig(env),
    activity: { get: () => activity, noteBot: () => events.push('noteBot') },
    personaSelector: { pickRandomUser: () => (events.push('pick'), 'dave') },
    composer: {
      composeRevive: async ({ persona, guild }) => {
        events.push(['compose', persona, guild === discord.state.guild]);
        if (failCompose) throw new Error('llm down');
        return { response: 'resp', payload: { content: 'c', embeds: [] } };
      },
    },
    clock: { now: () => BASE_TIME },
    logger: { info: (m) => logs.info.push(m), error: (...a) => logs.error.push(a) },
  };
  return { tick: createReviveTick(deps), events, logs, discord, client };
};

test('does nothing when revive is not due', async () => {
  const { tick, events } = setup({ activity: { lastMessageTime: BASE_TIME - 3 * HOUR, lastWasBot: false } });
  await tick();
  assert.deepEqual(events, []);
});

test('does nothing when the bot spoke last', async () => {
  const { tick, events } = setup({ activity: { lastMessageTime: 0, lastWasBot: true } });
  await tick();
  assert.deepEqual(events, []);
});

test('revives: claims activity first, sends the payload, claims again, logs', async () => {
  const { tick, events, logs, discord } = setup();
  await tick();
  assert.deepEqual(events, [
    'noteBot', ['fetch', '704837777564500149'], 'pick', ['compose', 'dave', true], 'noteBot',
  ]);
  assert.deepEqual(discord.state.channel.sent, [{ content: 'c', embeds: [] }]);
  assert.deepEqual(logs.info, ['[REVIVE] dave: resp']);
});

test('override revives regardless of activity', async () => {
  const { tick, discord } = setup({ env: { REVIVE_OVERRIDE: 'true' }, activity: { lastMessageTime: BASE_TIME, lastWasBot: true } });
  await tick();
  assert.equal(discord.state.channel.sent.length, 1);
});

test('fetches the guild through client.guilds when the channel has none', async () => {
  const { tick, events, discord, client } = setup();
  const channel = { ...discord.state.channel, guild: undefined };
  channel.send = async (payload) => channel.sent.push(payload);
  client.channels.fetch = async () => channel;
  await tick();
  assert.deepEqual(events.filter((e) => Array.isArray(e) && e[0] === 'guildFetch'), [['guildFetch', channel.guildId]]);
  assert.equal(channel.sent.length, 1);
});

test('generation failure keeps the claim, sends nothing and logs', async () => {
  const { tick, events, logs, discord } = setup({ failCompose: true });
  await tick();
  assert.equal(events.filter((e) => e === 'noteBot').length, 1);
  assert.deepEqual(discord.state.channel.sent, []);
  assert.equal(logs.error.length, 1);
});

test('does not await channel.send and logs a rejected send', async () => {
  const { tick, events, logs, discord } = setup();
  let rejectSend;
  discord.state.channel.send = () => new Promise((_, reject) => { rejectSend = reject; });
  await tick();
  assert.equal(events.at(-1), 'noteBot');
  rejectSend(new Error('send failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.error.length, 1);
});

test('a channel fetch failure is logged and never throws', async () => {
  const { tick, client, logs } = setup();
  client.channels.fetch = async () => { throw new Error('unknown channel'); };
  await tick();
  assert.equal(logs.error.length, 1);
});
