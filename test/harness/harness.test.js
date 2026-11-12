import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorld } from '../support/world.js';
import { createFakeChroma, fakeEmbed } from '../support/fakes/chroma.js';
import { BASE_TIME, CHANNEL_ID, ENV } from '../support/fixtures.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

test('sequential worlds are independent', async () => {
  const a = await createWorld({ random: 0 });
  const clientA = a.discord.client;
  const messageA = await a.emitMessage({ content: 'hello there friends' });
  assert.equal(messageA.replies.length, 1);
  await a.close();

  const b = await createWorld({ random: 0 });
  try {
    assert.notEqual(b.discord.client, clientA);
    assert.deepEqual(b.sqlite.all('SELECT id FROM messages'), []);
    const messageB = await b.emitMessage({ content: 'hello there friends' });
    assert.equal(messageB.replies.length, 1);
  } finally {
    await b.close();
  }
});

test('createWorld rejects while a world is open and after a boot failure leaves no patches', async () => {
  const realRandom = Math.random;
  const realFetch = globalThis.fetch;
  const world = await createWorld();
  await assert.rejects(createWorld(), /already open/);
  await world.close();

  const boom = new Error('heartbeat down');
  await assert.rejects(createWorld({ failHeartbeat: boom }), boom);
  assert.equal(Math.random, realRandom);
  assert.equal(globalThis.fetch, realFetch);

  const next = await createWorld();
  await next.close();
});

test('emitMessage from an approved author with random 0 replies once and records the message', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const message = await world.emitMessage({ id: 'm1', content: 'hello there friends' });
  assert.equal(message.replies.length, 1);
  assert.equal(world.llm.calls.length, 1);
  assert.deepEqual(world.sqlite.all('SELECT id FROM messages'), [{ id: 'm1' }]);
  assert.deepEqual(world.errors, []);
});

test('revive fires at +3h10m, once, and each interval sees its own time', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: 'hello there friends' });
  await world.advance(4 * HOUR);
  const { channel } = world.discord;
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sentMessages[0].createdTimestamp, BASE_TIME + 3 * HOUR + 10 * MINUTE);
  assert.equal(world.now(), BASE_TIME + 4 * HOUR);
});

test('reply command parks on the modal without blocking the world', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({ target: { content: 'hello there friends' }, user: 'carol' });
  assert.equal(interaction.modal.custom_id, 'replyModal');
  assert.equal(interaction.modalOptions.time, 120_000);

  await world.emitMessage({ content: 'another message here' });
  await world.advance(MINUTE);

  const submitted = await interaction.submit({ author: 'bob' });
  assert.equal(submitted.replies.length, 1);
  assert.equal(submitted.edits.length, 1);

  const other = await world.openReplyCommand({ target: { content: 'hello there friends' } });
  await other.timeout();
  assert.equal(other.replies.length, 0);
  assert.equal(world.errors.length, 0);
  assert.equal(world.logs.error.length, 1);
});

test('close with a pending modal does not hang', async () => {
  const world = await createWorld();
  await world.openReplyCommand({ target: { content: 'hello there friends' } });
  await world.close();
});

test('random, llm and gif controls', async (t) => {
  const world = await newWorld(t);
  world.setRandom([0.1, 0.2]);
  assert.deepEqual([Math.random(), Math.random(), Math.random()], [0.1, 0.2, 0.2]);
  world.setRandom((n) => n / 10);
  assert.deepEqual([Math.random(), Math.random()], [0, 0.1]);
  assert.equal(world.randomCalls, 5);

  world.llm.respondWith(['one', new Error('llm down'), 'three']);
  const { subject } = world;
  assert.equal(await subject.getRandomResponse('alice'), 'one');
  await assert.rejects(subject.getRandomResponse('alice'), /llm down/);
  assert.equal(await subject.getRandomResponse('alice'), 'three');
  assert.equal(await subject.getRandomResponse('alice'), 'three');
  assert.equal(world.llm.callClients[0].apiKey, ENV.DEEPSEEK_API_KEY);

  world.gifs.klipy.setResult('https://gif.example/cat.gif');
  const { gifLinks } = await subject.processGIFs('<gif! cat>');
  assert.equal(gifLinks[0].url, 'https://gif.example/cat.gif');
  world.gifs.klipy.setResult(new Error('klipy down'));
  await assert.rejects(subject.processGIFs('<gif! cat>'), /klipy down/);
  await assert.rejects(globalThis.fetch('https://other.example/x'), /unexpected fetch/);
});

test('fake chroma ranks, filters and projects', async () => {
  const { ChromaClient, state } = createFakeChroma();
  const col = await new ChromaClient().getOrCreateCollection({ name: 'c' });
  assert.equal(state.collection('c'), col);
  assert.throws(() => state.collection('nope'));
  assert.deepEqual((await col.query({ queryTexts: ['x'] })).ids, [[]]);

  col.seed([
    { id: 'a', document: 'red apple pie', metadata: { n: 1, tag: 'x' } },
    { id: 'b', document: 'green apple', metadata: { n: 2, tag: 'y' } },
    { id: 'c', document: 'blue car', metadata: { n: 3 } },
  ]);
  const ids = async (where) => (await col.query({ queryTexts: ['red apple pie'], where, include: [] })).ids[0];
  assert.deepEqual(await ids(), ['a', 'b', 'c']);
  assert.deepEqual(await ids({ tag: 'y' }), ['b']);
  assert.deepEqual(await ids({ $and: [{ n: { $lt: 3 } }, { tag: { $ne: 'y' } }] }), ['a']);
  assert.deepEqual(await ids({ $or: [{ n: 1 }, { n: 3 }] }), ['a', 'c']);
  assert.deepEqual(await ids({ tag: { $ne: 'x' } }), ['b', 'c']);
  assert.deepEqual(await ids({ tag: { $in: ['x', 'y'] } }), ['a', 'b']);
  assert.deepEqual(await ids({ tag: { $nin: ['x'] } }), ['b', 'c']);
  assert.deepEqual(await ids({ tag: 'missing' }), []);

  const full = await col.query({ queryEmbeddings: [fakeEmbed('blue car')], nResults: 1, include: ['documents'] });
  assert.deepEqual(full, { ids: [['c']], documents: [['blue car']] });
  assert.deepEqual(fakeEmbed('Blue, car!'), fakeEmbed('car blue'));
  assert.deepEqual(fakeEmbed('blue car'), fakeEmbed('blue car'));
  assert.equal(fakeEmbed('').length, 64);
});

test('guild members controls and channel lookup', async (t) => {
  const world = await newWorld(t);
  const { guild, client } = world.discord;
  const first = async (query) => (await guild.members.fetch({ query, limit: 1 })).first();
  assert.equal((await first('alice')).displayAvatarURL(), 'https://cdn.example/avatars/alice.png');
  guild.members.avatars.bob = 'https://cdn.example/custom.png';
  assert.equal((await first('bob')).displayAvatarURL(), 'https://cdn.example/custom.png');
  guild.members.avatars.carol = null;
  assert.equal((await first('carol')).displayAvatarURL(), null);
  guild.members.setMissing(true);
  assert.equal(await first('alice'), undefined);
  guild.members.setMissing(false);
  guild.members.setFailing(true);
  await assert.rejects(first('alice'));
  assert.equal(guild.members.calls.length, 5);
  await assert.rejects(client.channels.fetch('unknown'));
  assert.equal((await client.channels.fetch(CHANNEL_ID)).id, CHANNEL_ID);
});

test('close restores globals and the temp directory and keeps module mocks', async () => {
  process.env.KLIPY_API_KEY = 'sentinel';
  const before = {
    cwd: process.cwd(),
    random: Math.random,
    now: Date.now,
    fetch: globalThis.fetch,
    log: console.log,
  };
  const world = await createWorld();
  const dir = process.cwd();
  assert.notEqual(dir, before.cwd);
  assert.equal(process.env.KLIPY_API_KEY, ENV.KLIPY_API_KEY);
  await world.close();
  await world.close();
  assert.equal(process.cwd(), before.cwd);
  assert.equal(process.env.KLIPY_API_KEY, 'sentinel');
  assert.equal(Math.random, before.random);
  assert.equal(Date.now, before.now);
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(console.log, before.log);
  assert.equal(fs.existsSync(dir), false);
  delete process.env.KLIPY_API_KEY;

  const again = await createWorld();
  try {
    assert.equal(again.llm.constructed.length, 2);
  } finally {
    await again.close();
  }
});
