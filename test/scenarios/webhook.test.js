import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createWorld } from '../support/world.js';
import { REPLY_LINK_PREFIX } from '../../src/discord/webhookDelivery.js';

const HELLO = 'hello there friends';
const HOUR = 3_600_000;
const MINUTE = 60_000;
const RATE_LIMIT_GAP_MS = 6 * MINUTE;
const REVIVE_DUE_MS = 3 * HOUR + 10 * MINUTE;
const WEBHOOK_NAME = 'deep-pa-text';
const GONE = Object.assign(new Error('Unknown Webhook'), { code: 10015 });

const newWorld = async (t, options = {}) => {
  const world = await createWorld({ random: 0, ...options, env: { PERSONA_DISPLAY: 'webhook', ...options.env } });
  t.after(() => world.close());
  return world;
};

const hooks = (world) => world.discord.channel.webhooks;
const hookSends = (world) => [...hooks(world).list.values()].flatMap((hook) => hook.sent);
const botRows = (world) => world.sqlite.all('SELECT * FROM bot_messages ORDER BY rowid');
const webhookMessages = (world) => world.discord.channel.history.filter((m) => m.webhookId);

test('the default mode never makes a webhook call', async (t) => {
  const world = await createWorld({ random: 0 });
  t.after(() => world.close());
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(hooks(world).fetches, 0);
  assert.deepEqual(hooks(world).creates, []);
});

test('an auto reply goes out through the webhook with the member name, avatar and a reply link', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('sounds good to me');
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 0);
  assert.deepEqual(world.discord.channel.sent, []);
  const [payload] = hookSends(world);
  assert.equal(payload.username, 'bob-display');
  assert.equal(payload.avatarURL, 'https://cdn.example/avatars/bob.png');
  assert.deepEqual(payload.embeds, []);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.content, `${REPLY_LINK_PREFIX}${message.url}\nsounds good to me`);
  const [row] = botRows(world);
  assert.equal(row.id, webhookMessages(world)[0].id);
  assert.equal(row.content, 'sounds good to me');
  assert.deepEqual([row.persona, row.trigger, row.reference], ['bob', 'auto', message.id]);
});

test('GIF embeds are kept and no author embed is added', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult('https://gif.example/cat.gif');
  world.llm.respondWith('look at this <gif! cat>');
  await world.emitMessage({ content: HELLO });
  const [payload] = hookSends(world);
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].data.image.url, 'https://gif.example/cat.gif');
});

test('a bot-owned webhook with the configured name is reused; others are ignored; later sends do not look again', async (t) => {
  const world = await newWorld(t);
  hooks(world).add({ name: WEBHOOK_NAME, ownerId: 'someone' });
  hooks(world).add({ name: 'other' });
  const mine = hooks(world).add({ name: WEBHOOK_NAME });
  await world.emitMessage({ content: HELLO });
  await world.advance(RATE_LIMIT_GAP_MS);
  await world.emitMessage({ content: HELLO });
  assert.equal(mine.sent.length, 2);
  assert.deepEqual(hooks(world).creates, []);
  assert.equal(hooks(world).fetches, 1);
});

test('a webhook is created when none matches', async (t) => {
  const world = await newWorld(t);
  hooks(world).add({ name: WEBHOOK_NAME, ownerId: 'someone' });
  await world.emitMessage({ content: HELLO });
  assert.deepEqual(hooks(world).creates, [{ name: WEBHOOK_NAME }]);
});

test('two concurrent sends in a fresh channel create one webhook', async (t) => {
  const world = await newWorld(t);
  const target = { content: 'a replyable message' };
  const first = await world.openReplyCommand({ target });
  const second = await world.openReplyCommand({ target });
  await Promise.all([first.submit({ author: 'bob' }), second.submit({ author: 'bob' })]);
  assert.equal(hooks(world).creates.length, 1);
  assert.equal(hookSends(world).length, 2);
});

test('a failing createWebhook warns, delivers in embed form and the next send tries again', async (t) => {
  const world = await newWorld(t);
  hooks(world).failCreate(new Error('Missing Permissions'));
  const first = await world.emitMessage({ content: HELLO });
  assert.equal(first.replies.length, 1);
  assert.equal(first.replies[0].embeds.at(-1).data.author.name, 'bob');
  assert.equal(world.logs.warn.length, 1);
  await world.advance(RATE_LIMIT_GAP_MS);
  const second = await world.emitMessage({ content: HELLO });
  assert.equal(second.replies.length, 0);
  assert.equal(hooks(world).creates.length, 2);
  assert.equal(hookSends(world).length, 1);
});

test('a webhook deleted after caching falls back once and is looked up again next time', async (t) => {
  const world = await newWorld(t);
  const hook = hooks(world).add({ name: WEBHOOK_NAME });
  await world.emitMessage({ content: HELLO });
  hook.failSends(GONE);
  await world.advance(RATE_LIMIT_GAP_MS);
  const fell = await world.emitMessage({ content: HELLO });
  assert.equal(fell.replies.length, 1);
  await world.advance(RATE_LIMIT_GAP_MS);
  const after = await world.emitMessage({ content: HELLO });
  assert.equal(after.replies.length, 0);
  assert.equal(hooks(world).fetches, 2);
});

test('a send rejected for another reason falls back and keeps the cached webhook', async (t) => {
  const world = await newWorld(t);
  const hook = hooks(world).add({ name: WEBHOOK_NAME });
  await world.emitMessage({ content: HELLO });
  hook.failSends(Object.assign(new Error('Invalid Form Body'), { code: 50035 }));
  await world.advance(RATE_LIMIT_GAP_MS);
  const fell = await world.emitMessage({ content: HELLO });
  assert.equal(fell.replies.length, 1);
  await world.advance(RATE_LIMIT_GAP_MS);
  await world.emitMessage({ content: HELLO });
  assert.equal(hooks(world).fetches, 1);
});

test('a 100 character display name is cut to 80 code points', async (t) => {
  const world = await newWorld(t);
  world.discord.guild.members.update('bob', { displayName: 'n'.repeat(100) });
  await world.emitMessage({ content: HELLO });
  assert.equal(hookSends(world)[0].username, 'n'.repeat(80));
});

test('a display name with a forbidden word uses the username instead', async (t) => {
  const world = await newWorld(t);
  world.discord.guild.members.update('bob', { displayName: 'Discord Dan' });
  await world.emitMessage({ content: HELLO });
  assert.equal(hookSends(world)[0].username, 'bob');
});

test('when both names are forbidden the message falls back to the embed form without a webhook lookup', async (t) => {
  const users = [{ username: 'alice', name: 'A' }, { username: 'clydeish', name: 'C' }];
  const world = await newWorld(t, { users });
  world.discord.guild.members.update('clydeish', { displayName: 'Discord Bot' });
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(hooks(world).fetches, 0);
});

test('the reply command shows an ephemeral placeholder, sends via the webhook and edits the placeholder', async (t) => {
  const world = await newWorld(t);
  const command = await world.openReplyCommand({ target: { content: 'a replyable message' } });
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual(submitted.replies, [{
    content: 'Replying as bob…', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
  }]);
  const [payload] = hookSends(world);
  assert.equal(payload.username, 'bob-display');
  assert.ok(!payload.content.startsWith(REPLY_LINK_PREFIX));
  assert.deepEqual(submitted.edits, [{ content: 'Sent as bob.', allowedMentions: { parse: [] } }]);
  assert.equal(botRows(world)[0].trigger, 'command');
});

test('with the webhook failing the command persona message goes to the channel and the placeholder is still edited', async (t) => {
  const world = await newWorld(t);
  hooks(world).failCreate(new Error('Missing Permissions'));
  const command = await world.openReplyCommand({ target: { content: 'a replyable message' } });
  const submitted = await command.submit({ author: 'bob' });
  assert.equal(world.discord.channel.sent.length, 1);
  assert.equal(world.discord.channel.sent[0].embeds.at(-1).data.author.name, 'bob');
  assert.deepEqual(submitted.edits.map((e) => e.content), ['Sent as bob.']);
  assert.equal(botRows(world).length, 1);
});

test('every part of a burst goes through the webhook and only the first carries the reply link', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('one\n<split>\ntwo\n<split>\nthree');
  await world.emitMessage({ content: HELLO });
  const sends = hookSends(world);
  assert.deepEqual(sends.map((p) => p.content.split('\n').at(-1)), ['one', 'two', 'three']);
  assert.deepEqual(sends.map((p) => p.content.startsWith(REPLY_LINK_PREFIX)), [true, false, false]);
  assert.deepEqual(world.discord.channel.sent, []);
  assert.equal(botRows(world).length, 3);
});

test('a reply to a webhook message continues the chain with the stored persona', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ content: HELLO });
  world.setRandom(0.99);
  const [row] = botRows(world);
  await world.emitMessage({ author: 'alice', content: 'why though', reference: row.id });
  const rows = botRows(world);
  assert.deepEqual([rows[1].trigger, rows[1].persona], ['chain', row.persona]);
  assert.equal(hookSends(world).length, 2);
  assert.equal(hookSends(world)[1].username, 'bob-display');
});

test('a revive in webhook mode is a webhook message with no link line', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  await world.ready();
  await world.emitMessage({ content: HELLO });
  await world.advance(REVIVE_DUE_MS);
  const sends = hookSends(world);
  assert.equal(sends.length, 1);
  assert.ok(!sends[0].content.includes(REPLY_LINK_PREFIX));
  assert.deepEqual(world.discord.channel.sent, []);
  assert.equal(botRows(world)[0].trigger, 'revive');
});
