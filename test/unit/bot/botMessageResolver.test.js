import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotMessageResolver } from '../../../src/bot/botMessageResolver.js';

const BOT_ID = 'bot-user';
const directory = { usernames: new Set(['alice', 'bob']) };
const stored = { id: 'm1', persona: 'bob', content: 'stored text' };

const setup = (botId = BOT_ID) => createBotMessageResolver({
  botMessageStore: { getById: (id) => (id === 'm1' ? stored : null) },
  userDirectory: directory,
  getBotUserId: () => botId,
});

test('a store hit returns the stored persona and content', () => {
  const { resolve } = setup();
  assert.deepEqual(resolve({ id: 'm1', author: { id: 'x' }, content: 'shown' }), {
    persona: 'bob', content: 'stored text',
  });
});

test('a persona no longer in the user directory is still returned from the store', () => {
  const resolver = createBotMessageResolver({
    botMessageStore: { getById: () => ({ persona: 'gone', content: 'c' }) },
    userDirectory: directory,
    getBotUserId: () => BOT_ID,
  });
  assert.equal(resolver.resolve({ id: 'z' }).persona, 'gone');
});

test('the bot\'s own unstored message falls back to its embed author', () => {
  const message = { id: 'old', author: { id: BOT_ID }, content: 'delivered', embeds: [{ author: { name: 'alice' } }] };
  assert.deepEqual(setup().resolve(message), { persona: 'alice', content: 'delivered' });
});

test('an own message with no usable embed gives null', () => {
  const noEmbeds = { id: 'old', author: { id: BOT_ID }, content: 'c', embeds: [] };
  const unknown = { ...noEmbeds, embeds: [{ author: { name: 'mallory' } }] };
  assert.equal(setup().resolve(noEmbeds), null);
  assert.equal(setup().resolve(unknown), null);
});

test('a foreign bot or a human gives null even with a matching embed', () => {
  const embeds = [{ author: { name: 'alice' } }];
  assert.equal(setup().resolve({ id: 'o', author: { id: 'other-bot' }, embeds }), null);
  assert.equal(setup().resolve({ id: 'h', author: { id: 'user-alice' }, embeds }), null);
});

test('with no bot user id yet nothing falls back to embeds', () => {
  const embeds = [{ author: { name: 'alice' } }];
  assert.equal(setup(undefined).resolve({ id: 'o', author: { id: undefined }, embeds }), null);
});
