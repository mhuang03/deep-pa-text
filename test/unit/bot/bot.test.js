import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { createBot } from '../../../src/bot/bot.js';
import { loadConfig } from '../../../src/config.js';

const setup = (env = {}) => {
  const log = [];
  const intervals = [];
  const client = {
    user: { tag: 'bot#1' },
    once: (event, fn) => log.push(['once', event, fn]),
    on: (event, fn) => log.push(['on', event, fn]),
    login: async (token) => log.push(['login', token]),
  };
  const refreshes = [];
  const handlers = {
    messageCreate: () => {}, replyCommand: () => {}, messageDelete: () => {}, messageBulkDelete: () => {},
    messageUpdate: () => {}, reviveTick: () => {}, profileRefresh: () => refreshes.push('run'),
  };
  const infos = [];
  const bot = createBot({
    client,
    config: loadConfig({ DISCORD_BOT_TOKEN: 'tok', ...env }),
    handlers,
    clock: { setInterval: (fn, ms) => intervals.push([fn, ms]) },
    logger: { info: (m) => infos.push(m) },
  });
  return { bot, log, handlers, intervals, infos, refreshes };
};

test('start registers once and on listeners, then logs in', async () => {
  const { bot, log, handlers } = setup();
  await bot.start();
  assert.deepEqual(log.map(([kind, event]) => [kind, event]), [
    ['once', Events.ClientReady],
    ['on', Events.MessageCreate],
    ['on', Events.InteractionCreate],
    ['on', Events.MessageDelete],
    ['on', Events.MessageBulkDelete],
    ['on', Events.MessageUpdate],
    ['login', 'tok'],
  ]);
  assert.equal(log[1][2], handlers.messageCreate);
  assert.equal(log[2][2], handlers.replyCommand);
});

test('ready logs the tag and starts the revive interval at the normal period', async () => {
  const { bot, log, handlers, intervals, infos } = setup();
  await bot.start();
  assert.equal(intervals.length, 0);
  log[0][2]();
  assert.deepEqual(infos, ['Logged in as bot#1']);
  assert.deepEqual(intervals, [[handlers.reviveTick, 600000], [handlers.profileRefresh, 3600000]]);
});

test('ready uses the override period when revive override is on', async () => {
  const { bot, log, intervals } = setup({ REVIVE_OVERRIDE: 'true' });
  await bot.start();
  log[0][2]();
  assert.equal(intervals[0][1], 60000);
});

test('ready starts a profile refresh without awaiting it, then repeats it on the interval', async () => {
  const { bot, log, handlers, intervals, refreshes } = setup();
  handlers.profileRefresh = () => new Promise(() => {});
  await bot.start();
  assert.doesNotThrow(() => log[0][2]());
  assert.equal(intervals.at(-1)[0], handlers.profileRefresh);
  assert.equal(refreshes.length, 0);
});

test('ready runs one refresh immediately', async () => {
  const { bot, log, refreshes } = setup();
  await bot.start();
  log[0][2]();
  assert.equal(refreshes.length, 1);
});

test('a refresh interval of 0 disables the refresh at ready and the interval', async () => {
  const { bot, log, handlers, intervals, refreshes } = setup();
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'tok' });
  const off = createBot({
    client: { user: { tag: 't' }, once: (e, fn) => log.push(['once', e, fn]), on: () => {}, login: async () => {} },
    config: { ...config, profiles: { ...config.profiles, refreshIntervalMs: 0 } },
    handlers,
    clock: { setInterval: (fn, ms) => intervals.push([fn, ms]) },
    logger: { info: () => {} },
  });
  await off.start();
  log.at(-1)[2]();
  assert.deepEqual(intervals.map(([, ms]) => ms), [600000]);
  assert.equal(refreshes.length, 0);
  assert.ok(bot);
});
