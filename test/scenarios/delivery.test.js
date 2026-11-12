import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events, MessageFlags } from 'discord.js';
import { createWorld } from '../support/world.js';
import { GENERATION_FAILED_MESSAGE } from '../../src/discord/replyModal.js';
import { BASE_TIME, OTHER_CHANNEL_ID } from '../support/fixtures.js';

const HELLO = 'hello there friends';
const HOUR = 3_600_000;
const RATE_LIMIT = 300_000;
const MISSES_BEFORE_ESCALATION = 12;
const SEND_FAILED = new Error('Unknown Message');

const newWorld = async (t, options = { random: 0 }) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

// emitMessage builds its own message, so a test that must arm a failure first emits one itself.
const emitPrepared = async (world, message) => {
  world.discord.client.emit(Events.MessageCreate, message);
  await world.settle();
};

const failingMessage = (world, error = SEND_FAILED) => {
  const message = world.discord.makeMessage({ content: HELLO });
  message.failReplies(error);
  return message;
};


const handlerErrors = (world) => world.logs.error.filter((args) => args[1] instanceof Error);

test('a rejected message.reply is logged once, nothing throws and no reply is recorded', async (t) => {
  const world = await newWorld(t);
  const message = failingMessage(world);
  await emitPrepared(world, message);
  assert.equal(handlerErrors(world).length, 1);
  assert.equal(handlerErrors(world)[0][1], SEND_FAILED);
  assert.deepEqual(world.errors, []);
  assert.deepEqual(message.replies, []);
});

test('a delivery failure arms the rate limit: the next replyable message gets no LLM call', async (t) => {
  const world = await newWorld(t);
  await emitPrepared(world, failingMessage(world));
  assert.equal(world.llm.calls.length, 1);
  await world.advance(1);
  const next = await world.emitMessage({ content: HELLO });
  assert.deepEqual(next.replies, []);
  assert.equal(world.llm.calls.length, 1);
});

test('after the rate-limit window the bot replies again', async (t) => {
  const world = await newWorld(t);
  await emitPrepared(world, failingMessage(world));
  await world.advance(RATE_LIMIT);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 1);
});

test('a delivery failure leaves the miss counter unchanged', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  for (let i = 0; i < MISSES_BEFORE_ESCALATION; i += 1) await world.emitMessage({ content: HELLO });
  world.setRandom(0);
  await emitPrepared(world, failingMessage(world));
  await world.advance(RATE_LIMIT);
  // 12 misses give a chance of 0.2; a reset counter would give 0.1 and reject this roll.
  world.setRandom(0.15);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 1);
});

test('a successful reply resets the miss counter', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  for (let i = 0; i < MISSES_BEFORE_ESCALATION; i += 1) await world.emitMessage({ content: HELLO });
  world.setRandom(0);
  await world.emitMessage({ content: HELLO });
  await world.advance(RATE_LIMIT);
  world.setRandom(0.15);
  const next = await world.emitMessage({ content: HELLO });
  assert.deepEqual(next.replies, []);
});

test('an LLM failure is logged and does not arm the rate limit', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith([new Error('llm down'), 'fine now']);
  await world.emitMessage({ content: HELLO });
  assert.equal(handlerErrors(world).length, 1);
  await world.advance(1);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 1);
});

test('a rejected channel.send during a revive is logged and nothing throws', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  await world.ready();
  await world.emitMessage({ content: HELLO });
  world.discord.channel.failSends(SEND_FAILED);
  await world.advanceTo(BASE_TIME + 4 * HOUR);
  assert.equal(handlerErrors(world).length, 1);
  assert.equal(handlerErrors(world)[0][1], SEND_FAILED);
  assert.deepEqual(world.errors, []);
  assert.deepEqual(world.discord.channel.sent, []);
});

test('a revive is delivered through channel.send with safe mentions and no repliedUser', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  await world.ready();
  await world.emitMessage({ content: HELLO });
  await world.advanceTo(BASE_TIME + 4 * HOUR);
  assert.deepEqual(world.discord.channel.sent.map((p) => p.allowedMentions), [{ parse: [] }]);
});

test('a command whose editReply fails gets one further edit with the failure notice', async (t) => {
  const world = await newWorld(t);
  const command = await world.openReplyCommand({ target: { content: HELLO } });
  const submitted = await command.submit({ author: 'bob', failEdits: { error: SEND_FAILED } });
  assert.equal(submitted.replies.length, 1);
  assert.deepEqual(submitted.edits, [{ content: GENERATION_FAILED_MESSAGE, embeds: [], allowedMentions: { parse: [] } }]);
  assert.equal(handlerErrors(world).length, 1);
  assert.deepEqual(world.errors, []);
});

test('a command whose generation fails gets the failure notice and arms no rate limit', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith([new Error('llm down'), 'fine now']);
  const command = await world.openReplyCommand({ target: { content: HELLO } });
  const submitted = await command.submit({ author: 'bob' });
  assert.equal(submitted.edits.length, 1);
  assert.equal(submitted.edits[0].content, GENERATION_FAILED_MESSAGE);
  assert.deepEqual(submitted.edits[0].embeds, []);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 1);
});

test('when the failure notice also fails the handler only logs', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith(new Error('llm down'));
  const command = await world.openReplyCommand({ target: { content: HELLO } });
  const submitted = await command.submit({ author: 'bob', failEdits: { error: SEND_FAILED, times: 2 } });
  assert.deepEqual(submitted.edits, []);
  assert.equal(handlerErrors(world).length, 2);
  assert.deepEqual(world.errors, []);
});

test('a command whose thinking placeholder fails sends no edit and logs', async (t) => {
  const world = await newWorld(t);
  const command = await world.openReplyCommand({ target: { content: HELLO } });
  const submitted = await command.submit({ author: 'bob', failReply: { error: SEND_FAILED } });
  assert.deepEqual(submitted.edits, []);
  assert.equal(handlerErrors(world).length, 1);
});

test('a failed command leaves reply state untouched', async (t) => {
  const world = await newWorld(t);
  const command = await world.openReplyCommand({ target: { content: HELLO } });
  await command.submit({ author: 'bob', failEdits: { error: SEND_FAILED, times: 2 } });
  await world.advance(1);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 1);
});

const MENTION_TEXT = 'hey @everyone and @here look <@111>';

test('LLM output with @everyone and <@111> is sent with parse [] on a reply', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith(MENTION_TEXT);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies[0].content, MENTION_TEXT);
  assert.deepEqual(message.replies[0].allowedMentions.parse, []);
});

test('LLM output with mentions is sent with parse [] on a revive and on a command edit', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  world.llm.respondWith(MENTION_TEXT);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  await world.advanceTo(BASE_TIME + 4 * HOUR);
  assert.deepEqual(world.discord.channel.sent[0].allowedMentions, { parse: [] });
  const command = await world.openReplyCommand({ target: { content: HELLO } });
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual(submitted.edits[0].allowedMentions, { parse: [] });
  assert.deepEqual(submitted.replies[0].allowedMentions, { parse: [] });
});

test('both ephemeral refusals carry safe mentions', async (t) => {
  const world = await newWorld(t);
  const unreplyable = await world.openReplyCommand({ target: { content: 'hi' } });
  const wrongChannel = await world.openReplyCommand({
    target: { content: HELLO, channel: world.discord.otherChannel },
  });
  assert.equal(world.discord.otherChannel.id, OTHER_CHANNEL_ID);
  [unreplyable, wrongChannel].forEach((interaction) => {
    assert.equal(interaction.replies.length, 1);
    assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(interaction.replies[0].allowedMentions, { parse: [] });
  });
});

test('the client is constructed with non-parsing allowedMentions as well as intents', async (t) => {
  const world = await newWorld(t);
  assert.deepEqual(world.discord.clientOptions.allowedMentions, { parse: [] });
  assert.ok(world.discord.clientOptions.intents.length > 0);
});

test('an auto reply pings the replied user by default', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ content: HELLO });
  assert.deepEqual(message.replies[0].allowedMentions, { parse: [], repliedUser: true });
});

test('PING_REPLIED_USER=false stops the reply ping', async (t) => {
  const world = await newWorld(t, { random: 0, env: { PING_REPLIED_USER: 'false' } });
  const message = await world.emitMessage({ content: HELLO });
  assert.deepEqual(message.replies[0].allowedMentions, { parse: [], repliedUser: false });
});

test('a command edit carries safe mentions without repliedUser', async (t) => {
  const world = await newWorld(t);
  const command = await world.openReplyCommand({ target: { content: HELLO } });
  const submitted = await command.submit({ author: 'bob' });
  assert.equal('repliedUser' in submitted.edits[0].allowedMentions, false);
});
