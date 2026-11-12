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
    responder: {
      respond: async (request) => {
        events.push(['respond', request.trigger, request.persona, request.target, request.guild === discord.state.guild, request.channel === discord.state.channel]);
        if (failCompose) throw new Error('llm down');
        if (request.via.type !== 'channel') throw new Error('unexpected via');
        const message = await request.via.channel.send({ content: 'c', embeds: [] });
        return { response: 'resp', message };
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

test('revives: claims activity first, responds through the channel, claims again, logs', async () => {
  const { tick, events, logs, discord } = setup();
  await tick();
  assert.deepEqual(events, [
    'noteBot', ['fetch', '704837777564500149'], 'pick', ['respond', 'revive', 'dave', null, true, true], 'noteBot',
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

test('a rejected send is logged, never thrown, and the second claim is skipped', async () => {
  const { tick, events, logs, discord } = setup();
  discord.state.channel.failSends(new Error('send failed'));
  await tick();
  assert.equal(events.filter((e) => e === 'noteBot').length, 1);
  assert.equal(logs.error.length, 1);
  assert.deepEqual(logs.info, []);
});

test('a channel fetch failure is logged and never throws', async () => {
  const { tick, client, logs } = setup();
  client.channels.fetch = async () => { throw new Error('unknown channel'); };
  await tick();
  assert.equal(logs.error.length, 1);
});
