import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const HELLO = 'hello there friends';
const WITH_GIF = 'lol <gif! cat>';

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const botRows = (world) => world.sqlite.all('SELECT * FROM bot_messages ORDER BY timestamp, id');

test('an auto reply is stored with its persona, reference, trigger and GIF token', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.gifs.klipy.setResult(['https://g.example/0.gif']);
  world.llm.respondWith(WITH_GIF);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  const [row] = botRows(world);
  assert.equal(botRows(world).length, 1);
  assert.equal(row.trigger, 'auto');
  assert.equal(row.reference, message.id);
  assert.equal(row.content, WITH_GIF);
  assert.equal(row.persona, message.replies[0].embeds.at(-1).data.author.name);
  assert.equal(row.timestamp, BASE_TIME);
});

test('a revive is stored with a null reference', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  world.llm.respondWith(WITH_GIF);
  await world.advance(3 * HOUR + 10 * MINUTE);
  const [row] = botRows(world);
  const sent = world.discord.channel.sentMessages[0];
  assert.equal(botRows(world).length, 1);
  assert.equal(row.id, sent.id);
  assert.equal(row.trigger, 'revive');
  assert.equal(row.reference, null);
  assert.equal(row.content, WITH_GIF);
  assert.equal(row.persona, sent.embeds.at(-1).data.author.name);
});

test('a command reply is stored with the target as its reference', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith(WITH_GIF);
  const target = world.discord.makeMessage({ content: HELLO });
  const interaction = await world.openReplyCommand({ target });
  await interaction.submit({ author: 'carol' });
  const rows = botRows(world);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].persona, 'carol');
  assert.equal(rows[0].trigger, 'command');
  assert.equal(rows[0].reference, target.id);
  assert.equal(rows[0].content, WITH_GIF);
});

test('a failed send records nothing', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const message = world.discord.makeMessage({ content: HELLO });
  message.failReplies(new Error('Unknown Message'));
  world.discord.client.emit('messageCreate', message);
  await world.settle();
  assert.deepEqual(botRows(world), []);
});
