import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const BLURPLE = 0x5865F2;
const HELLO = 'hello there friends';

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const sent = (world) => world.discord.channel.sent;
const authorEmbed = (payload) => payload.embeds.at(-1).data;

// Arms the revive timer with a human message at BASE_TIME (the default roll of 0.99 loses the reply roll).
const armedWorld = async (t, options) => {
  const world = await newWorld(t, options);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  return world;
};

// Revive is due at BASE_TIME + 3 h 10 min.
const triggerRevive = (world) => world.advance(3 * HOUR + 10 * MINUTE);

test('without ready() advancing time never sends anything', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ content: HELLO });
  await world.advance(48 * HOUR);
  assert.deepEqual(sent(world), []);
  assert.equal(world.llm.calls.length, 0);
});

test('a fresh start with no human message never revives', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.advance(48 * HOUR);
  assert.deepEqual(sent(world), []);
});

test('daytime: exactly 3 hours idle sends nothing, 10 minutes later sends one revive', async (t) => {
  const world = await armedWorld(t);
  await world.advance(3 * HOUR);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('idle time is measured from the message createdTimestamp, not its arrival', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: HELLO, timestamp: BASE_TIME - 2 * HOUR });
  await world.advance(HOUR);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
  assert.equal(world.discord.channel.sentMessages[0].createdTimestamp, BASE_TIME + HOUR + 10 * MINUTE);
});

test('ready() emitted twice starts one interval', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.ready();
  await world.emitMessage({ content: HELLO });
  await triggerRevive(world);
  assert.equal(sent(world).length, 1);
  assert.equal(world.llm.calls.length, 1);
});

test('a bot-authored message does not delay a revive', async (t) => {
  const world = await armedWorld(t);
  await world.advance(2 * HOUR + 30 * MINUTE);
  await world.emitMessage({ content: HELLO, bot: true });
  await world.advance(40 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('a bot-authored message does not arm a revive', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: HELLO, bot: true });
  await world.advance(48 * HOUR);
  assert.deepEqual(sent(world), []);
});

test('the revive is sent with channel.send, not as a reply, with the persona chosen by one roll', async (t) => {
  const world = await armedWorld(t);
  world.setRandom(0.99);
  world.llm.respondWith('anyone up for lunch');
  const calls = world.randomCalls;
  await triggerRevive(world);
  assert.equal(world.randomCalls - calls, 1);
  assert.equal(sent(world).length, 1);
  const [payload] = sent(world);
  assert.equal(payload.content, 'anyone up for lunch');
  assert.equal(payload.embeds.length, 1);
  const { author, color } = authorEmbed(payload);
  assert.equal(author.name, 'dave');
  assert.equal(author.icon_url, 'https://cdn.example/avatars/dave.png');
  assert.equal(color, BLURPLE);
});

test('a revive roll of 0 picks the first user', async (t) => {
  const world = await armedWorld(t);
  world.setRandom(0);
  await triggerRevive(world);
  assert.equal(authorEmbed(sent(world)[0]).author.name, 'alice');
});

test('a resolved GIF token becomes an image embed ahead of the author embed and leaves the content', async (t) => {
  const world = await armedWorld(t);
  world.llm.respondWith('look at this <gif! cat>');
  world.gifs.klipy.setResult('https://gif.example/cat.gif');
  await triggerRevive(world);
  const [payload] = sent(world);
  assert.equal(payload.content, 'look at this ');
  assert.equal(payload.embeds.length, 2);
  assert.equal(payload.embeds[0].data.image.url, 'https://gif.example/cat.gif');
  assert.equal(payload.embeds[1].data.author.name, 'dave');
});

// Spec 23: a failed lookup uses the stored profile, which the ready-time refresh already recorded.
test('an avatar lookup failure still sends the revive, with the stored profile icon', async (t) => {
  const world = await armedWorld(t);
  world.discord.guild.members.setFailing(true);
  await triggerRevive(world);
  assert.equal(sent(world).length, 1);
  const { author } = authorEmbed(sent(world)[0]);
  assert.equal(author.name, 'dave');
  assert.equal(author.icon_url, 'https://cdn.example/avatars/dave.png');
});

test('the revive LLM prompt lists the persona\'s seeded messages as starters and examples only', async (t) => {
  const world = await newWorld(t);
  const seeded = ['dave says one thing', 'dave says another thing', 'dave says a third thing'];
  await world.seed(seeded.map((content, i) => ({
    id: `d${i}`, author: 'dave', content, timestamp: BASE_TIME - (i + 1) * 1000,
  })));
  await world.ready();
  await world.emitMessage({ content: HELLO });
  await triggerRevive(world);
  assert.equal(world.llm.calls.length, 1);
  const prompt = world.llm.calls[0].messages[1].content;
  const arrays = prompt.split('\n').filter((line) => line.startsWith('["')).map((line) => JSON.parse(line));
  assert.deepEqual(arrays.flat().sort(), [...seeded].sort());
  assert.equal(world.llm.calls[0].messages[0].content, world.subject.REVIVE_SYSTEM_PROMPT);
});

test('never twice in a row: no second revive without a new human message, which re-arms it', async (t) => {
  const world = await armedWorld(t);
  await triggerRevive(world);
  await world.advance(48 * HOUR);
  assert.equal(sent(world).length, 1);
  await world.emitMessage({ content: HELLO });
  await triggerRevive(world);
  assert.equal(sent(world).length, 2);
});

test('after an auto reply there is no revive until another human message', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.ready();
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  await world.advance(48 * HOUR);
  assert.deepEqual(sent(world), []);
});

test('a filtered-out human message restarts the idle timer from its timestamp', async (t) => {
  const world = await armedWorld(t);
  await world.advance(2 * HOUR);
  await world.emitMessage({ content: 'hi' });
  await world.advance(3 * HOUR);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('a human message that loses the probability roll restarts the idle timer', async (t) => {
  const world = await armedWorld(t);
  await world.advance(2 * HOUR);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 0);
  await world.advance(3 * HOUR);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('night rule: last message at 21:00 Central revives only after more than 12 hours', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.advanceTo(BASE_TIME + 9 * HOUR);
  await world.emitMessage({ content: HELLO });
  await world.advanceTo(BASE_TIME + 21 * HOUR);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('daytime starts at hour 10: last message at 23:00 Central revives at 10:00, not before', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.advanceTo(BASE_TIME + 11 * HOUR);
  await world.emitMessage({ content: HELLO });
  await world.advanceTo(BASE_TIME + 21 * HOUR + 50 * MINUTE);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('hour 22 is still daytime: last message at 18:50 Central revives at 22:00', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.advanceTo(BASE_TIME + 6 * HOUR + 50 * MINUTE);
  await world.emitMessage({ content: HELLO });
  await world.advanceTo(BASE_TIME + 9 * HOUR + 50 * MINUTE);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('hour 23 is night: last message at 19:50 Central does not revive at 23:00 but does at 08:00', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.advanceTo(BASE_TIME + 7 * HOUR + 50 * MINUTE);
  await world.emitMessage({ content: HELLO });
  await world.advanceTo(BASE_TIME + 11 * HOUR);
  assert.deepEqual(sent(world), []);
  await world.advanceTo(BASE_TIME + 19 * HOUR + 50 * MINUTE);
  assert.deepEqual(sent(world), []);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('an LLM failure during a revive sends nothing, throws nothing and is not retried until a new human message', async (t) => {
  const world = await armedWorld(t);
  world.llm.respondWith(new Error('llm down'));
  await triggerRevive(world);
  assert.deepEqual(sent(world), []);
  assert.equal(world.llm.calls.length, 1);
  await world.advance(48 * HOUR);
  assert.equal(world.llm.calls.length, 1);
  assert.deepEqual(sent(world), []);
  assert.deepEqual(world.errors, []);
  await world.emitMessage({ content: HELLO });
  await triggerRevive(world);
  assert.equal(world.llm.calls.length, 2);
  assert.deepEqual(sent(world), []);
});
