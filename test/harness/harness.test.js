import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(interaction.modal.custom_id, `replyModal:${interaction.id}`);
  assert.equal(interaction.modalOptions.time, 120_000);
  assert.equal(typeof interaction.modalOptions.filter, 'function');

  await world.emitMessage({ content: 'another message here' });
  await world.advance(MINUTE);

  const submitted = await interaction.submit({ author: 'bob' });
  assert.equal(submitted.replies.length, 1);
  assert.equal(submitted.edits.length, 1);

  const other = await world.openReplyCommand({ target: { content: 'hello there friends' } });
  await other.timeout();
  assert.equal(other.replies.length, 0);
  assert.equal(world.errors.length, 0);
  assert.equal(world.logs.error.length, 0);
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

  world.llm.respondWith([null, '', { choices: [] }, { choices: [{ message: { content: 'raw' } }] }]);
  const probe = new world.fakes.llm.OpenAI({ apiKey: 'k' });
  const ask = async () => probe.chat.completions.create({ messages: [] });
  assert.equal((await ask()).choices[0].message.content, null);
  assert.equal((await ask()).choices[0].message.content, '');
  assert.deepEqual(await ask(), { choices: [] });
  assert.equal((await ask()).choices[0].message.content, 'raw');

  world.gifs.klipy.setResult('https://gif.example/cat.gif');
  const { gifLinks } = await subject.processGIFs('<gif! cat>');
  assert.equal(gifLinks[0].url, 'https://gif.example/cat.gif');
  world.gifs.klipy.setResult(new Error('klipy down'));
  const { gifLinks: failed } = await subject.processGIFs('<gif! cat>');
  assert.equal(failed[0].url, '');
  assert.equal(world.logs.warn.length, 1);
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

test('close restores globals and a later world still gets fake clients', async () => {
  const before = {
    random: Math.random,
    now: Date.now,
    fetch: globalThis.fetch,
    log: console.log,
  };
  const world = await createWorld();
  await world.close();
  await world.close();
  assert.equal(Math.random, before.random);
  assert.equal(Date.now, before.now);
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(console.log, before.log);

  const again = await createWorld();
  try {
    assert.equal(again.llm.constructed.length, 1);
  } finally {
    await again.close();
  }
});

test('fake modal waits: submit is offered to every wait, timeout rejects with a collector error', async (t) => {
  const world = await newWorld(t);
  const a = await world.openReplyCommand({ target: { content: 'hello there friends' }, user: 'alice' });
  const b = await world.openReplyCommand({ target: { content: 'hello there friends' }, user: 'bob' });
  assert.throws(() => a.awaitModalSubmit({}), /numeric time/);
  const stray = await a.submit({ author: 'bob', user: { id: 'user-zed', username: 'zed' } });
  assert.deepEqual(stray.replies, []);
  await b.timeout();
  await assert.rejects(b.timeout(), /no modal wait is pending/);
  assert.equal((await a.submit({ author: 'bob' })).replies.length, 1);
});

test('world.advance fires mocked setTimeout timers', async (t) => {
  const world = await newWorld(t);
  const fired = [];
  setTimeout(() => fired.push('t'), 1000);
  await world.advance(999);
  assert.deepEqual(fired, []);
  await world.advance(1);
  assert.deepEqual(fired, ['t']);
});

test('fake gifs setResult accepts strings, arrays, null, errors, hang, status, body and functions', async (t) => {
  const world = await newWorld(t);
  const { fetch, GiphyFetch } = world.fakes.gifs;
  const klipy = () => fetch('https://api.klipy.com/api/v1/k/gifs/search?q=cat');
  const jsonOf = async () => (await klipy()).json();
  world.gifs.klipy.setResult(['https://a/1.gif', 'https://a/2.gif']);
  assert.equal((await jsonOf()).data.data.length, 2);
  world.gifs.klipy.setResult(null);
  assert.deepEqual((await jsonOf()).data.data, []);
  world.gifs.klipy.setResult({ status: 503 });
  assert.deepEqual([(await klipy()).ok, (await klipy()).status], [false, 503]);
  world.gifs.klipy.setResult({ body: { odd: true } });
  assert.deepEqual(await jsonOf(), { odd: true });
  world.gifs.klipy.setResult((q) => `https://a/${q}.gif`);
  assert.equal((await jsonOf()).data.data[0].file.hd.gif.url, 'https://a/cat.gif');
  world.gifs.klipy.setResult(new Error('down'));
  await assert.rejects(klipy(), /down/);
  world.gifs.klipy.setResult({ hang: true });
  assert.equal(await Promise.race([klipy(), Promise.resolve('pending')]), 'pending');
  world.gifs.giphy.setResult(['https://a/1.gif', 'https://a/2.gif', 'https://a/3.gif']);
  const found = await new GiphyFetch('k').search('cat', { limit: 2 });
  assert.equal(found.data.length, 2);
});
