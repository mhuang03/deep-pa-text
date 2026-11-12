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
  const handlers = { messageCreate: () => {}, replyCommand: () => {}, reviveTick: () => {} };
  const infos = [];
  const bot = createBot({
    client,
    config: loadConfig({ DISCORD_BOT_TOKEN: 'tok', ...env }),
    handlers,
    clock: { setInterval: (fn, ms) => intervals.push([fn, ms]) },
    logger: { info: (m) => infos.push(m) },
  });
  return { bot, log, handlers, intervals, infos };
};

test('start registers once and on listeners, then logs in', async () => {
  const { bot, log, handlers } = setup();
  await bot.start();
  assert.deepEqual(log.map(([kind, event]) => [kind, event]), [
    ['once', Events.ClientReady],
    ['on', Events.MessageCreate],
    ['on', Events.InteractionCreate],
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
  assert.deepEqual(intervals, [[handlers.reviveTick, 600000]]);
});

test('ready uses the override period when revive override is on', async () => {
  const { bot, log, intervals } = setup({ REVIVE_OVERRIDE: 'true' });
  await bot.start();
  log[0][2]();
  assert.equal(intervals[0][1], 60000);
});
