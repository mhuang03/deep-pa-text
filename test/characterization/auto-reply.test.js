import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const HOUR = 3_600_000;
const RATE_LIMIT = 300_000;
const BLURPLE = 0x5865F2;

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

// Seeds reply embeddings so that searchLikelyRepliers('hello there friends') is [bob, carol].
const seedRepliers = (world) => world.seed([
  { id: 't1', author: 'dave', content: 'hello there friends', timestamp: BASE_TIME - 5000 },
  { id: 'r1', author: 'bob', content: 'bob replies to hello', timestamp: BASE_TIME - 4000, reference: 't1' },
  { id: 't2', author: 'dave', content: 'zzz qqq www vvv', timestamp: BASE_TIME - 3000 },
  { id: 'r2', author: 'carol', content: 'carol replies to zzz', timestamp: BASE_TIME - 2000, reference: 't2' },
]);

const HELLO = 'hello there friends';
const countRows = (world, table) => world.sqlite.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
const userPrompt = (world, index = 0) => world.llm.calls[index].messages[1].content;
const authorEmbed = (payload) => payload.embeds.at(-1).data;
const sendMany = async (world, count, content = HELLO) => {
  const messages = [];
  for (let i = 0; i < count; i += 1) messages.push(await world.emitMessage({ content }));
  return messages;
};
const replyCount = (messages) => messages.filter((m) => m.replies.length > 0).length;

test('a message in another channel is ignored', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const message = await world.emitMessage({ content: HELLO, channel: world.discord.otherChannel });
  assert.equal(countRows(world, 'messages'), 0);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(message.replies.length, 0);
  assert.equal(world.randomCalls, 0);
});

test('a bot-authored message is ignored', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const message = await world.emitMessage({ content: HELLO, bot: true });
  assert.equal(countRows(world, 'messages'), 0);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(message.replies.length, 0);
  assert.equal(world.randomCalls, 0);
});

test('a message in the channel is recorded even when it is not replied to', async (t) => {
  const world = await newWorld(t, { random: 0.5 });
  await world.emitMessage({ id: 'm1', content: HELLO });
  assert.deepEqual(world.sqlite.all('SELECT id, content FROM messages'), [{ id: 'm1', content: HELLO }]);
});

test('a roll above the chance gives no reply and no LLM call', async (t) => {
  const world = await newWorld(t, { random: 0.5 });
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
});

test('a roll equal to the chance replies', async (t) => {
  const world = await newWorld(t, { random: 0.1 });
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
});

test('a roll just above the chance does not reply', async (t) => {
  const world = await newWorld(t, { random: 0.11 });
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
});

test('a reply is one message.reply with the processed content, a persona embed and nothing on channel.send', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith('sounds good to me');
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  const [payload] = message.replies;
  assert.equal(payload.content, 'sounds good to me');
  assert.equal(payload.embeds.length, 1);
  const { author, color } = authorEmbed(payload);
  assert.equal(author.name, 'alice');
  assert.equal(author.icon_url, 'https://cdn.example/avatars/alice.png');
  assert.equal(color, BLURPLE);
  assert.deepEqual(world.discord.guild.members.calls, [{ query: 'alice', limit: 1 }]);
  assert.deepEqual(world.discord.channel.sent, []);
});

test('the LLM user prompt names the persona, its real name and the transformed message content', async (t) => {
  const world = await newWorld(t, { random: [0, 0, 0.99] });
  await world.emitMessage({ content: '<@111> hello there' });
  assert.equal(world.llm.calls.length, 1);
  const prompt = userPrompt(world);
  assert.ok(prompt.includes('username "dave"'));
  assert.ok(prompt.includes('real name is "Dave Example"'));
  assert.ok(prompt.includes('The user has just received the message: "@alice hello there".'));
  assert.ok(!prompt.includes('<@111>'));
});

test('persona is the first likely replier for rolls [0, 0]', async (t) => {
  const world = await newWorld(t, { random: [0, 0] });
  await seedRepliers(world);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(authorEmbed(message.replies[0]).author.name, 'bob');
  assert.equal(world.randomCalls, 2);
});

test('persona is the last likely replier for rolls [0, 0.99]', async (t) => {
  const world = await newWorld(t, { random: [0, 0.99] });
  await seedRepliers(world);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(authorEmbed(message.replies[0]).author.name, 'carol');
  assert.equal(world.randomCalls, 2);
});

test('with no likely repliers the fallback roll indexes USERS', async (t) => {
  const world = await newWorld(t, { random: [0, 0, 0.99] });
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(authorEmbed(message.replies[0]).author.name, 'dave');
  assert.equal(world.randomCalls, 3);
});

test('the fallback persona can be the message author itself', async (t) => {
  const world = await newWorld(t, { random: [0, 0, 0] });
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(authorEmbed(message.replies[0]).author.name, 'alice');
});

test('a non-approved author can be replied to but gets no filtered_messages row', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const message = await world.emitMessage({ author: 'mallory', content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(countRows(world, 'messages'), 1);
  assert.equal(countRows(world, 'filtered_messages'), 0);
});

test('a message failing the content filters is never replied to and consumes no roll', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const message = await world.emitMessage({ content: 'hi' });
  assert.equal(message.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(world.randomCalls, 0);
});

test('a message failing the content filters does not count as a miss', async (t) => {
  const world = await newWorld(t, { random: 0.12 });
  await sendMany(world, 12, 'hi');
  const replyable = await sendMany(world, 12);
  assert.deepEqual(replyable.map((m) => m.replies.length), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('a second replyable message less than 300000 ms after a reply is rate limited', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const first = await world.emitMessage({ content: HELLO });
  await world.advance(RATE_LIMIT - 1);
  const second = await world.emitMessage({ content: HELLO });
  assert.equal(first.replies.length, 1);
  assert.equal(second.replies.length, 0);
  assert.equal(world.llm.calls.length, 1);
});

test('a replyable message exactly 300000 ms after a reply is replied to', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.emitMessage({ content: HELLO });
  await world.advance(RATE_LIMIT);
  const second = await world.emitMessage({ content: HELLO });
  assert.equal(second.replies.length, 1);
  assert.equal(world.llm.calls.length, 2);
});

test('rate-limited messages do not count as misses', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.emitMessage({ content: HELLO });
  await sendMany(world, 15);
  world.setRandom(0.12);
  await world.advance(RATE_LIMIT);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 0);
});

test('with a constant roll of 0.12 the 12th replyable message is replied to', async (t) => {
  const world = await newWorld(t, { random: 0.12 });
  const messages = await sendMany(world, 12);
  assert.deepEqual(messages.map((m) => m.replies.length), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('the miss counter resets after a reply', async (t) => {
  const world = await newWorld(t, { random: 0.12 });
  await sendMany(world, 12);
  await world.advance(RATE_LIMIT);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 0);
});

test('with a constant roll of 0.99 the 29th replyable message is replied to', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  const messages = await sendMany(world, 29);
  assert.equal(replyCount(messages.slice(0, 28)), 0);
  assert.equal(messages[28].replies.length, 1);
});

test('an avatar lookup failure still sends the reply without an icon', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.discord.guild.members.setFailing(true);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  const { author } = authorEmbed(message.replies[0]);
  assert.equal(author.name, 'alice');
  assert.ok(!author.icon_url);
  assert.deepEqual(world.errors, []);
});

test('an LLM failure sends no reply, records no error and consumes the roll', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith(new Error('llm down'));
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 0);
  assert.deepEqual(world.errors, []);
  assert.equal(world.llm.calls.length, 1);
  assert.equal(world.randomCalls, 3);
});

test('an LLM failure does not arm the rate limit', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith([new Error('llm down'), 'fine now']);
  await world.emitMessage({ content: HELLO });
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 1);
  assert.equal(next.replies[0].content, 'fine now');
});

test('an LLM failure leaves the miss counter unchanged', async (t) => {
  const world = await newWorld(t, { random: 0.12 });
  await sendMany(world, 11);
  world.llm.respondWith([new Error('llm down'), 'fine now']);
  const failed = await world.emitMessage({ content: HELLO });
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(failed.replies.length, 0);
  assert.equal(world.llm.calls.length, 2);
  assert.equal(next.replies.length, 1);
});

test('an LLM failure leaves the bot as last author so no revive happens until a human message', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.ready();
  world.llm.respondWith(new Error('llm down'));
  await world.emitMessage({ content: HELLO });
  await world.advance(48 * HOUR);
  assert.deepEqual(world.discord.channel.sent, []);
  assert.equal(world.llm.calls.length, 1);
  assert.deepEqual(world.errors, []);
});

test('an ingest failure keeps the messages row, attempts no reply, and later messages work after recovery', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const collection = world.chroma.collection('message_embeddings');
  collection.setFailing(new Error('chroma down'));
  const failed = await world.emitMessage({ id: 'm1', content: HELLO });
  assert.equal(failed.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
  assert.deepEqual(world.errors, []);
  assert.deepEqual(world.sqlite.all('SELECT id FROM messages'), [{ id: 'm1' }]);

  collection.setFailing(null);
  const next = await world.emitMessage({ id: 'm2', content: HELLO });
  assert.equal(next.replies.length, 1);
  assert.equal(countRows(world, 'messages'), 2);
});

test('a rate-limited message consumes no roll', async (t) => {
  const world = await newWorld(t, { random: [0, 0, 0.5, 0] });
  await seedRepliers(world);
  const first = await world.emitMessage({ content: HELLO });
  const second = await world.emitMessage({ content: HELLO });
  await world.advance(RATE_LIMIT);
  const third = await world.emitMessage({ content: HELLO });
  assert.equal(first.replies.length, 1);
  assert.equal(second.replies.length, 0);
  assert.equal(third.replies.length, 0);
  assert.equal(world.randomCalls, 3);
});

test('a resolved GIF token becomes an image embed ahead of the author embed and leaves the content', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith('haha <gif! cat>');
  world.gifs.klipy.setResult('https://gif.example/cat.gif');
  const message = await world.emitMessage({ content: HELLO });
  const [payload] = message.replies;
  assert.equal(payload.content, 'haha ');
  assert.equal(payload.embeds.length, 2);
  assert.equal(payload.embeds[0].data.image.url, 'https://gif.example/cat.gif');
  assert.equal(payload.embeds[1].data.author.name, 'alice');
});

test('an unresolved GIF token stays as an INSERT GIF placeholder with only the author embed', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith('haha <gif! cat>');
  const message = await world.emitMessage({ content: HELLO });
  const [payload] = message.replies;
  assert.ok(payload.content.includes('<INSERT GIF:'));
  assert.ok(!payload.content.includes('<gif!'));
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].data.author.name, 'alice');
});
