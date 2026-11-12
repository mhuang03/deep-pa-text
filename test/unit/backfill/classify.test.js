import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessages } from '../../../src/backfill/classify.js';

const msg = (id, { authorId = `u-${id}`, bot = false, webhookId = null } = {}) => ({
  id, author: { id: authorId, bot }, webhookId,
});
const context = (overrides = {}) => ({
  botUserId: 'bot', ownWebhookIds: new Set(['wh-own']), isKnownBotMessage: () => false, ...overrides,
});

test('a message from the bot user is the bot\'s own', () => {
  const { ownBot, humans } = classifyMessages([msg('1', { authorId: 'bot', bot: true })], context());
  assert.deepEqual(ownBot.map((m) => m.id), ['1']);
  assert.equal(humans.length, 0);
});

test('a message from one of the bot\'s own webhooks is the bot\'s own', () => {
  const { ownBot } = classifyMessages([msg('1', { bot: true, webhookId: 'wh-own' })], context());
  assert.deepEqual(ownBot.map((m) => m.id), ['1']);
});

test('a message known by id is the bot\'s own even from an unlisted webhook', () => {
  const known = context({ isKnownBotMessage: (id) => id === '1' });
  const { ownBot, otherBots } = classifyMessages([msg('1', { bot: true, webhookId: 'gone' })], known);
  assert.deepEqual(ownBot.map((m) => m.id), ['1']);
  assert.equal(otherBots, 0);
});

test('other bots and other applications\' webhooks are counted and dropped', () => {
  const result = classifyMessages([
    msg('1', { bot: true }), msg('2', { bot: true, webhookId: 'wh-other' }),
  ], context());
  assert.deepEqual(result, { humans: [], ownBot: [], otherBots: 2 });
});

test('everything else is human and order is preserved', () => {
  const { humans } = classifyMessages([msg('1'), msg('2', { authorId: 'bot', bot: true }), msg('3')], context());
  assert.deepEqual(humans.map((m) => m.id), ['1', '3']);
});

test('an empty webhook set recognises no webhook messages by webhook id', () => {
  const { otherBots } = classifyMessages(
    [msg('1', { bot: true, webhookId: 'wh-own' })], context({ ownWebhookIds: new Set() }),
  );
  assert.equal(otherBots, 1);
});
