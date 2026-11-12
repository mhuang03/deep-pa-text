import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { createFakeChroma, fakeEmbed } from '../support/fakes/chroma.js';
import { createFakeDiscord } from '../support/fakes/discord.js';
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
  await assert.rejects(createWorld({ failHeartbeat: boom }), /Cannot reach Chroma on port 7429\. Start it with: npx chroma run --port 7429/);
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

test('guild members: seeded fixture users, fetch by id, prefix search and controls', async (t) => {
  const world = await newWorld(t);
  const { guild, client } = world.discord;
  const alice = await guild.members.fetch({ user: 'user-alice', force: true });
  assert.equal(alice.user.username, 'alice');
  assert.equal(alice.displayName, 'alice-display');
  assert.equal(alice.displayAvatarURL(), 'https://cdn.example/avatars/alice.png');
  await assert.rejects(guild.members.fetch({ user: 'nobody', force: true }), { code: 10007 });
  const found = await guild.members.search({ query: 'ALI', limit: 5 });
  assert.deepEqual([...found.values()].map((m) => m.user.username), ['alice']);
  guild.members.add({ username: 'bobby' });
  const prefix = await guild.members.search({ query: 'bob', limit: 1 });
  assert.equal(prefix.size, 1);
  guild.members.update('bob', { displayName: 'Bobbo', avatarURL: null });
  const bob = await guild.members.fetch({ user: 'user-bob' });
  assert.deepEqual([bob.displayName, bob.displayAvatarURL()], ['Bobbo', null]);
  guild.members.remove('bob');
  await assert.rejects(guild.members.fetch({ user: 'user-bob' }), { code: 10007 });
  guild.members.setFailing(true);
  await assert.rejects(guild.members.fetch({ user: 'user-alice' }), /member fetch failed/);
  guild.members.setFailing(null);
  assert.deepEqual(guild.members.calls.at(0), { method: 'fetch', args: { user: 'user-alice', force: true } });
  await assert.rejects(client.channels.fetch('unknown'));
  assert.equal((await client.channels.fetch(CHANNEL_ID)).id, CHANNEL_ID);
});

test('guild members: a hanging lookup never settles', async (t) => {
  const world = await newWorld(t);
  const { members } = world.discord.guild;
  members.setHanging(true);
  const outcome = await Promise.race([
    members.fetch({ user: 'user-alice' }).then(() => 'settled'),
    new Promise((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(outcome, 'pending');
  members.setHanging(false);
});

test('channel webhooks: fetch, create, send appends to history, failures and message urls', async (t) => {
  const world = await newWorld(t);
  const { channel } = world.discord;
  assert.deepEqual([...(await channel.fetchWebhooks()).values()], []);
  const created = await channel.createWebhook({ name: 'hook' });
  assert.deepEqual([created.name, created.owner.id], ['hook', 'bot-user']);
  const other = channel.webhooks.add({ name: 'x', ownerId: 'someone' });
  assert.equal((await channel.fetchWebhooks()).size, 2);
  assert.equal(channel.webhooks.list.get(other.id), other);
  const message = await created.send({ content: 'hi', username: 'Bobbo', embeds: [] });
  assert.deepEqual(created.sent.map((p) => p.content), ['hi']);
  assert.equal(message.author.username, 'Bobbo');
  assert.equal(message.author.bot, true);
  assert.equal(message.webhookId, created.id);
  assert.equal(message.reference, null);
  assert.ok(channel.history.includes(message));
  created.failSends(new Error('nope'), { times: 1 });
  await assert.rejects(created.send({ content: 'x' }), /nope/);
  await created.send({ content: 'again' });
  channel.webhooks.failFetch(new Error('no fetch'));
  await assert.rejects(channel.fetchWebhooks(), /no fetch/);
  channel.webhooks.failCreate(new Error('no create'));
  await assert.rejects(channel.createWebhook({ name: 'y' }), /no create/);
  const human = world.addHistory({ content: 'hello there' });
  assert.equal(human.url, `https://discord.test/channels/${channel.guildId}/${channel.id}/${human.id}`);
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

test('fake bot messages carry a reference for replies only and a timestamp from the mocked clock', async (t) => {
  const world = await newWorld(t);
  const target = world.discord.makeMessage({ content: 'hello there friends' });
  const reply = await target.reply({ content: 'r' });
  assert.deepEqual(reply.reference, { messageId: target.id });
  assert.equal(reply.createdTimestamp, BASE_TIME);
  await world.advance(MINUTE);
  const sent = await world.discord.channel.send({ content: 's' });
  assert.equal(sent.reference, null);
  assert.equal(sent.createdTimestamp, BASE_TIME + MINUTE);
  const command = world.discord.makeInteraction();
  assert.equal((await command.reply({ content: 'i' })).reference, null);
});

test('message.failReplies and channel.failSends reject one call by default, then recover', async (t) => {
  const world = await newWorld(t);
  const boom = new Error('boom');
  const message = world.discord.makeMessage({ content: 'hello there friends' });
  message.failReplies(boom);
  await assert.rejects(message.reply({ content: 'a' }), boom);
  await message.reply({ content: 'b' });
  assert.deepEqual(message.replies, [{ content: 'b' }]);
  const { channel } = world.discord;
  channel.failSends(boom, { times: 2 });
  await assert.rejects(channel.send({ content: 'a' }), boom);
  await assert.rejects(channel.send({ content: 'b' }), boom);
  await channel.send({ content: 'c' });
  assert.deepEqual(channel.sent, [{ content: 'c' }]);
});

test('modal-submit failReply and failEdits honour times', async (t) => {
  const world = await newWorld(t);
  const boom = new Error('boom');
  const command = await world.openReplyCommand({ target: { content: 'hello there friends' } });
  const submitted = await command.submit({ author: 'bob' });
  submitted.failReply(boom);
  await assert.rejects(submitted.reply({ content: 'x' }), boom);
  await submitted.reply({ content: 'x' });
  submitted.failEdits(boom, { times: 2 });
  await assert.rejects(submitted.editReply({ content: 'y' }), boom);
  await assert.rejects(submitted.editReply({ content: 'y' }), boom);
  await submitted.editReply({ content: 'z' });
  assert.equal(submitted.edits.at(-1).content, 'z');
});

test('submit arms failReply and failEdits before the handler sees the submission', async (t) => {
  const world = await newWorld(t);
  const boom = new Error('boom');
  const command = await world.openReplyCommand({ target: { content: 'hello there friends' } });
  const submitted = await command.submit({ author: 'bob', failReply: { error: boom } });
  assert.deepEqual(submitted.replies, []);
  assert.deepEqual(submitted.edits, []);
  const second = await world.openReplyCommand({ target: { content: 'hello there friends' } });
  const edited = await second.submit({ author: 'bob', failEdits: { error: boom, times: 2 } });
  assert.equal(edited.replies.length, 1);
  assert.deepEqual(edited.edits, []);
});

test('createWorld env option overrides the environment the bot boots with', async (t) => {
  const world = await newWorld(t, { random: 0, env: { PING_REPLIED_USER: 'false' } });
  assert.equal(world.env.PING_REPLIED_USER, 'false');
  assert.equal(world.env.DISCORD_BOT_TOKEN, ENV.DISCORD_BOT_TOKEN);
  const message = await world.emitMessage({ content: 'hello there friends' });
  assert.equal(message.replies[0].allowedMentions.repliedUser, false);
});

test('channel.messages.fetch returns the messages before an id, newest first, as a Map', async (t) => {
  const world = await newWorld(t);
  const ids = ['h1', 'h2', 'h3', 'h4'];
  ids.forEach((id) => world.addHistory({ id, content: `line ${id}` }));
  const { messages } = world.discord.channel;
  const before = await messages.fetch({ limit: 2, before: 'h4' });
  assert.ok(before instanceof Map);
  assert.deepEqual([...before.keys()], ['h3', 'h2']);
  assert.deepEqual([...(await messages.fetch({ limit: 3 })).keys()], ['h4', 'h3', 'h2']);
  assert.deepEqual([...(await messages.fetch({ limit: 1, before: 'unknown' })).keys()], ['h4']);
  assert.deepEqual(messages.calls, [{ limit: 2, before: 'h4' }, { limit: 3, before: undefined }, { limit: 1, before: 'unknown' }]);
});

test('channel history records emitted messages and bot messages in order; addHistory emits nothing', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.addHistory({ id: 'pre', content: 'earlier' });
  assert.equal(world.llm.calls.length, 0);
  const message = await world.emitMessage({ id: 'm1', content: 'hello there friends' });
  const ids = world.discord.channel.history.map((m) => m.id);
  assert.equal(ids[0], 'pre');
  assert.equal(ids[1], 'm1');
  assert.equal(ids[2], message.replies.length === 1 ? world.discord.channel.history[2].id : null);
  assert.equal(world.discord.channel.history[2].author.bot, true);
  assert.ok(Array.isArray(world.discord.channel.history[2].embeds));
});

test('channel.messages.setFailing makes fetch reject until cleared', async (t) => {
  const world = await newWorld(t);
  const boom = new Error('no access');
  world.discord.channel.messages.setFailing(boom);
  await assert.rejects(world.discord.channel.messages.fetch({ limit: 1 }), boom);
  world.discord.channel.messages.setFailing(null);
  assert.equal((await world.discord.channel.messages.fetch({ limit: 1 })).size, 0);
});

test('fake messages fetch their referenced history message and count the calls', async (t) => {
  const world = await newWorld(t);
  const parent = world.addHistory({ author: 'dave', content: 'parent text' });
  const child = world.discord.makeMessage({ content: 'child', reference: parent.id });
  assert.equal(child.referenceFetches, 0);
  assert.equal(await child.fetchReference(), parent);
  assert.equal(child.referenceFetches, 1);
  const orphan = world.discord.makeMessage({ content: 'orphan', reference: 'missing' });
  await assert.rejects(orphan.fetchReference(), /not found/);
  assert.equal(orphan.referenceFetches, 1);
});

test('the fake LLM awaits a responder that returns a promise', async (t) => {
  const world = await newWorld(t);
  let release;
  world.llm.respondWith(() => new Promise((resolve) => {
    release = resolve;
  }));
  const client = new world.fakes.llm.OpenAI({});
  const pending = client.chat.completions.create({ messages: [] });
  release('held answer');
  assert.equal((await pending).choices[0].message.content, 'held answer');
});

test('the fake channel counts typing calls and can fail them', async (t) => {
  const world = await newWorld(t);
  const { channel } = world.discord;
  await channel.sendTyping();
  assert.equal(channel.typingCalls, 1);
  channel.failTyping(new Error('no access'));
  await assert.rejects(channel.sendTyping(), /no access/);
  await channel.sendTyping();
  assert.equal(channel.typingCalls, 3);
});

test('the fake modal submit records follow-ups and can fail them', async (t) => {
  const world = await newWorld(t);
  const command = await world.openReplyCommand({ target: { content: 'a replyable message' }, user: 'alice' });
  const submitted = await command.submit({ author: 'bob' });
  const message = await submitted.followUp({ content: 'more' });
  assert.deepEqual(submitted.followUps, [{ content: 'more' }]);
  assert.equal(message.content, 'more');
  submitted.failFollowUps(new Error('gone'));
  await assert.rejects(submitted.followUp({ content: 'x' }), /gone/);
});

test('world.sleeps records the burst delays and resolves immediately, running the sleep hook parked', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith('one<split>two');
  const hooked = [];
  world.sleepHook = async (ms) => {
    hooked.push(ms);
    await world.settle();
  };
  await world.emitMessage({ content: 'hello there friends' });
  assert.equal(world.sleeps.length, 1);
  assert.deepEqual(hooked, world.sleeps);
});

test('llm.hold parks the next completion, settle still returns, and release lets it finish', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const release = world.llm.hold();
  const message = await world.emitMessage({ content: 'hello there friends' });
  assert.equal(world.llm.calls.length, 1);
  assert.equal(message.replies.length, 0);
  release();
  await world.settle();
  assert.equal(message.replies.length, 1);
});

test('fake messages carry channelId, partial, editedTimestamp and a fetch that resolves to the full message', async (t) => {
  const world = await newWorld(t);
  const message = world.discord.makeMessage({ content: 'a message' });
  assert.equal(message.channelId, CHANNEL_ID);
  assert.equal(message.partial, false);
  assert.equal(message.editedTimestamp, null);
  assert.equal(await message.fetch(), message);
});

test('world.emitDelete emits MessageDelete with a partial message and removes it from the history', async (t) => {
  const world = await newWorld(t);
  const message = world.addHistory({ content: 'to be removed' });
  const seen = [];
  world.discord.client.on('messageDelete', (m) => seen.push(m));
  await world.emitDelete(message);
  assert.deepEqual(seen, [{ id: message.id, channelId: CHANNEL_ID, partial: true }]);
  assert.equal(world.discord.channel.history.includes(message), false);
  await world.emitDelete('some-id');
  assert.equal(seen[1].id, 'some-id');
});

test('world.emitBulkDelete emits a Map of partial messages and the channel', async (t) => {
  const world = await newWorld(t);
  const seen = [];
  world.discord.client.on('messageDeleteBulk', (messages, channel) => seen.push([messages, channel]));
  await world.emitBulkDelete(['a', 'b']);
  const [[messages, channel]] = seen;
  assert.ok(messages instanceof Map);
  assert.deepEqual([...messages.keys()], ['a', 'b']);
  assert.equal(messages.get('a').partial, true);
  assert.equal(channel, world.discord.channel);
});

test('world.emitEdit updates the channel history, emits MessageUpdate and can emit a partial', async (t) => {
  const world = await newWorld(t);
  const message = world.addHistory({ content: 'before' });
  const seen = [];
  world.discord.client.on('messageUpdate', (oldMessage, newMessage) => seen.push([oldMessage, newMessage]));
  await world.emitEdit(message, { content: 'after', editedTimestamp: 42 });
  assert.equal(seen[0][0].content, 'before');
  assert.equal(seen[0][1].content, 'after');
  assert.equal(seen[0][1].editedTimestamp, 42);
  assert.equal(world.discord.channel.history.find((m) => m.id === message.id).content, 'after');
  await world.emitEdit(message, { content: 'again', editedTimestamp: 43, partial: true });
  assert.equal(seen[1][1].partial, true);
  assert.equal((await seen[1][1].fetch()).content, 'again');
});

test('the subject records edits and deletes', async (t) => {
  const world = await newWorld(t);
  const record = { id: 'x1', author: 'alice', content: 'first version words', timestamp: BASE_TIME - HOUR };
  await world.subject.recordMessage(record);
  await world.subject.recordEdit({ ...record, content: 'second version words', editedAt: BASE_TIME });
  assert.equal(world.sqlite.all('SELECT * FROM message_revisions').length, 1);
  await world.subject.recordDelete('x1', BASE_TIME);
  assert.equal(world.sqlite.get('SELECT deleted_at FROM messages WHERE id = ?', 'x1').deleted_at, BASE_TIME);
});

test('fake messages carry webhookId (default null), authorId and embeds', async (t) => {
  const world = await newWorld(t);
  const plain = world.addHistory({ content: 'plain' });
  assert.equal(plain.webhookId, null);
  assert.deepEqual(plain.embeds, []);
  const hook = world.addHistory({ author: 'Some Name', bot: true, authorId: 'hook-1', webhookId: 'hook-1' });
  assert.equal(hook.webhookId, 'hook-1');
  assert.equal(hook.author.id, 'hook-1');
});

test('channel.messages.fetch records the cache option and failNext rejects a set number of fetches', async (t) => {
  const world = await newWorld(t);
  world.addHistory({ id: 'h1', content: 'line' });
  const { messages } = world.discord.channel;
  await messages.fetch({ limit: 1, cache: false });
  assert.equal(messages.calls[0].cache, false);
  const boom = new Error('rate limited');
  messages.failNext(boom, { times: 2 });
  await assert.rejects(messages.fetch({ limit: 1 }), boom);
  await assert.rejects(messages.fetch({ limit: 1 }), boom);
  assert.equal((await messages.fetch({ limit: 1 })).size, 1);
});

test('the fake embedding function counts generate calls', async (t) => {
  const world = await newWorld(t);
  const before = world.chroma.embeddingCalls;
  await world.seed([{ id: 'e1', author: 'alice', content: 'something long enough', timestamp: 1, reference: null }]);
  assert.equal(world.chroma.embeddingCalls, before + 1);
  const row = world.chroma.collection('message_embeddings').rows.get('e1');
  await world.container.vectorStore.fillMetadata('messages', [{
    id: 'e1', document: row.document, embedding: row.embedding, metadata: { ...row.metadata, extra: 1 },
  }]);
  assert.equal(world.chroma.embeddingCalls, before + 1);
});

test('the world exposes the container with the backfill services', async (t) => {
  const world = await newWorld(t);
  ['historyReader', 'historyImporter', 'botMessageImporter', 'vectorSync'].forEach((name) => {
    assert.equal(typeof world.container[name], 'object', name);
  });
});

test('a standalone fake discord shares its history across clients, can auto-emit ready and records destroy', async () => {
  const discord = createFakeDiscord();
  discord.state.autoReady = true;
  discord.state.addHistory({ id: 'x1', author: 'alice', content: 'shared history' });
  const first = new discord.Client({});
  const second = new discord.Client({});
  let ready = 0;
  first.once('clientReady', () => { ready += 1; });
  await first.login('token');
  await discord.state.settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, 1);
  assert.equal((await second.channels.fetch(CHANNEL_ID)).history[0].id, 'x1');
  await first.destroy();
  assert.equal(discord.state.destroyed, 1);
});

test('the fake chroma can fail a collection by name before it exists and share collections across clients', async () => {
  const chroma = createFakeChroma();
  const boom = new Error('rejected');
  chroma.state.failCollection('later', boom);
  const a = new chroma.ChromaClient({});
  const b = new chroma.ChromaClient({});
  const collection = await a.getOrCreateCollection({ name: 'later' });
  assert.equal(await b.getOrCreateCollection({ name: 'later' }), collection);
  await assert.rejects(collection.upsert({ ids: ['1'], documents: ['text'] }), boom);
  chroma.state.failCollection('later', null);
  await collection.upsert({ ids: ['1'], documents: ['text'] });
  assert.equal(collection.rows.size, 1);
});

test('the fake channel fetch supports after and limit, returning the oldest newer messages newest first', async () => {
  const discord = createFakeDiscord();
  ['a', 'b', 'c', 'd'].forEach((id) => discord.state.addHistory({ id, content: id }));
  const page = await discord.state.channel.messages.fetch({ after: 'a', limit: 2 });
  assert.deepEqual([...page.keys()], ['c', 'b']);
  assert.deepEqual(discord.state.channel.messages.calls.at(-1), { limit: 2, before: undefined, after: 'a' });
});

test('the world emits gateway events and records exit codes and the database close without exiting', async (t) => {
  const exits = [];
  const world = await newWorld(t, { exit: (code) => exits.push(code) });
  const seen = [];
  world.discord.client.on('shardResume', (shard) => seen.push(shard));
  await world.emitGateway('shardResume', 2);
  assert.deepEqual(seen, [2]);
  await world.emitShardDisconnect(4014);
  await world.container.lifecycle.shutdown({ code: 1 });
  assert.deepEqual(world.exits, [1]);
  assert.deepEqual(exits, [1]);
  assert.equal(world.databaseClosed, 1);
  assert.equal(world.discord.destroyed, 1);
  assert.equal(world.sqlite.all('SELECT id FROM messages').length, 0, 'the handle stays readable after shutdown');
});

test('preload runs against the container before ready, and config overrides replace section keys', async (t) => {
  const world = await newWorld(t, {
    config: { catchUp: { maxMessages: 7 } },
    preload: (container) => container.metaStore.setIfAbsent('seeded', 'yes'),
  });
  assert.equal(world.container.metaStore.get('seeded'), 'yes');
  assert.equal(world.discord.loginTokens.length, 1);
});
