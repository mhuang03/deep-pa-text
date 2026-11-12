import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const HELLO = 'hello there friends';
const DAY = 86_400_000;
const PAIR_GAP_MS = 5_000;
const PAIRS = 12;
const BURST_SECTION = /several short messages in a row/;
const MIN_DELAY = 800;
const MAX_DELAY = 4_000;
const TYPING_REFRESH = 8_000;

const newWorld = async (t, options = { random: 0 }) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

// Bob has replied to HELLO before (so he is the persona) and often sends two messages in a row.
const seedBursty = async (world, { author = 'bob', pairs = PAIRS } = {}) => {
  const messages = [
    { id: 'p0', author: 'dave', content: HELLO, timestamp: BASE_TIME - DAY },
    { id: 'r0', author, content: 'bob earlier reply', timestamp: BASE_TIME - DAY + 1000, reference: 'p0' },
  ];
  for (let i = 0; i < pairs; i += 1) {
    const start = BASE_TIME - 10 * DAY + i * 600_000;
    messages.push({ id: `a${i}`, author, content: `bursty first ${i}`, timestamp: start });
    messages.push({ id: `b${i}`, author, content: `bursty second ${i}`, timestamp: start + PAIR_GAP_MS });
  }
  await world.seed(messages);
};

const botRows = (world) => world.sqlite.all('SELECT * FROM bot_messages ORDER BY rowid');
const embedAuthor = (payload) => payload.embeds.at(-1).data.author.name;
const lastUser = (world) => world.llm.calls.at(-1).messages.find((m) => m.role === 'user').content;

const burstWorld = async (t, response, options) => {
  const world = await newWorld(t, options);
  await seedBursty(world);
  world.llm.respondWith(response);
  return world;
};

test('a bursty persona is told it may split, and a split response becomes a reply plus a channel message', async (t) => {
  const world = await burstWorld(t, 'one\n<split>\ntwo');
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.match(lastUser(world), BURST_SECTION);
  assert.equal(message.replies.length, 1);
  assert.equal(message.replies[0].content, 'one');
  const [second] = world.discord.channel.sent;
  assert.equal(second.content, 'two');
  assert.equal(embedAuthor(second), 'bob');
  assert.deepEqual(second.allowedMentions, { parse: [] });
  assert.equal(world.sleeps.length, 1);
  assert.ok(world.sleeps[0] >= MIN_DELAY && world.sleeps[0] <= MAX_DELAY);
  const rows = botRows(world);
  assert.deepEqual(rows.map((r) => r.content), ['one', 'two']);
  assert.deepEqual(rows.map((r) => [r.persona, r.trigger, r.reference]), [
    ['bob', 'auto', message.id], ['bob', 'auto', message.id],
  ]);
});

test('each part has its quotes removed separately', async (t) => {
  const world = await burstWorld(t, '"one"\n<split>\n"two"');
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(message.replies[0].content, 'one');
  assert.equal(world.discord.channel.sent[0].content, 'two');
});

test('four parts with a maximum of three become three messages, the last holding parts 3 and 4', async (t) => {
  const world = await burstWorld(t, 'p1<split>p2<split>p3<split>p4');
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(message.replies[0].content, 'p1');
  assert.deepEqual(world.discord.channel.sent.map((p) => p.content), ['p2', 'p3\np4']);
  assert.equal(world.sleeps.length, 2);
  assert.equal(botRows(world).length, 3);
});

test('a persona without enough samples gets no burst section but a stray marker is still honoured', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    { id: 'p0', author: 'dave', content: HELLO, timestamp: BASE_TIME - DAY },
    { id: 'r0', author: 'bob', content: 'bob earlier reply', timestamp: BASE_TIME - DAY + 1000, reference: 'p0' },
  ]);
  world.llm.respondWith('one\n<split>\ntwo');
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.doesNotMatch(lastUser(world), BURST_SECTION);
  assert.equal(message.replies[0].content, 'one');
  assert.equal(world.discord.channel.sent[0].content, 'two');
});

test('a persona who rarely bursts gets no burst section', async (t) => {
  const world = await newWorld(t);
  const messages = [
    { id: 'p0', author: 'dave', content: HELLO, timestamp: BASE_TIME - DAY },
    { id: 'r0', author: 'bob', content: 'bob earlier reply', timestamp: BASE_TIME - DAY + 1000, reference: 'p0' },
  ];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ id: `s${i}`, author: 'bob', content: `spread out ${i}`, timestamp: BASE_TIME - 10 * DAY + i * 600_000 });
  }
  await world.seed(messages);
  await world.emitMessage({ author: 'alice', content: HELLO });
  assert.doesNotMatch(lastUser(world), BURST_SECTION);
});

test('with BURSTS=false there is no section and the marker becomes a newline in one message', async (t) => {
  const world = await burstWorld(t, 'one\n<split>\ntwo', { random: 0, env: { BURSTS: 'false' } });
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.doesNotMatch(lastUser(world), BURST_SECTION);
  assert.equal(message.replies[0].content, 'one\ntwo');
  assert.deepEqual(world.discord.channel.sent, []);
  assert.deepEqual(world.sleeps, []);
});

test('a part that is only a GIF token is sent with empty content and a GIF embed, recorded as the token', async (t) => {
  const world = await burstWorld(t, 'one\n<split>\n<gif! cat>');
  world.gifs.klipy.setResult('https://g.example/cat.gif');
  await world.emitMessage({ author: 'alice', content: HELLO });
  const [second] = world.discord.channel.sent;
  assert.equal(second.content, '');
  assert.equal(second.embeds.length, 2);
  assert.equal(botRows(world)[1].content, '<gif! cat>');
});

test('a part that is empty after sanitising is dropped', async (t) => {
  const world = await burstWorld(t, 'one\n<split>\n""');
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.deepEqual(world.discord.channel.sent, []);
  assert.deepEqual(world.sleeps, []);
});

test('a failing second part is logged, the first stays and the reply state is already updated', async (t) => {
  const world = await burstWorld(t, 'one<split>two<split>three');
  world.discord.channel.failSends(new Error('Missing Permissions'));
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.deepEqual(world.discord.channel.sent, []);
  assert.equal(botRows(world).length, 1);
  assert.equal(world.logs.error.some((args) => args.some((a) => a instanceof Error && /Missing/.test(a.message))), true);
  const next = await world.emitMessage({ author: 'carol', content: 'another replyable message' });
  assert.equal(next.replies.length, 0);
});

test('a human message arriving between the parts is rate limited and gets no reply', async (t) => {
  const world = await burstWorld(t, 'one<split>two');
  const arrivals = [];
  world.sleepHook = async () => {
    arrivals.push(await world.emitMessage({ author: 'carol', content: 'something replyable mid burst' }));
  };
  await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].replies.length, 0);
  assert.equal(world.llm.calls.length, 1);
  assert.deepEqual(world.discord.channel.sent.map((p) => p.content), ['two']);
});

test('typing: one indicator at the start plus one pulse per later part', async (t) => {
  const world = await burstWorld(t, 'one<split>two<split>three');
  await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(world.discord.channel.typingCalls, 3);
});

test('typing is sent once for a plain reply and a failing sendTyping does not stop the reply', async (t) => {
  const world = await newWorld(t);
  world.discord.channel.failTyping(new Error('no access'), { times: 10 });
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(world.discord.channel.typingCalls, 1);
  assert.equal(message.replies.length, 1);
  assert.equal(world.logs.warn.filter((args) => /typing/.test(String(args[0]))).length, 1);
});

test('typing refreshes while a completion is held and stops after the reply', async (t) => {
  const world = await newWorld(t);
  const release = world.llm.hold();
  const pending = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(world.discord.channel.typingCalls, 1);
  await world.advance(2 * TYPING_REFRESH + 4_000);
  assert.equal(world.discord.channel.typingCalls, 3);
  release();
  await world.settle();
  assert.equal(pending.replies.length, 1);
  const total = world.discord.channel.typingCalls;
  await world.advance(3 * TYPING_REFRESH);
  assert.equal(world.discord.channel.typingCalls, total);
});

test('the reply command sends later parts as follow-ups and never shows typing', async (t) => {
  const world = await newWorld(t, {});
  world.llm.respondWith('one<split>two');
  const command = await world.openReplyCommand({ target: { content: 'a replyable message' }, user: 'alice' });
  const submitted = await command.submit({ author: 'bob' });
  assert.equal(submitted.edits.at(-1).content, 'one');
  assert.equal(submitted.followUps.length, 1);
  assert.equal(submitted.followUps[0].content, 'two');
  assert.deepEqual(submitted.followUps[0].allowedMentions, { parse: [] });
  assert.equal(world.discord.channel.typingCalls, 0);
  assert.equal(world.sleeps.length, 1);
  assert.deepEqual(botRows(world).map((r) => r.trigger), ['command', 'command']);
});

test('replying to the second message of a burst continues one chain turn holding both lines', async (t) => {
  const world = await burstWorld(t, 'one<split>two');
  await world.emitMessage({ author: 'alice', content: HELLO });
  const [first, second] = botRows(world);
  world.setRandom(0.99);
  world.llm.respondWith('third');
  const reply = await world.emitMessage({ author: 'alice', content: 'why', reference: second.id });
  assert.equal(reply.replies.length, 1);
  const { messages } = world.llm.calls.at(-1);
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(messages[2].content, 'one\ntwo');
  assert.equal(botRows(world).at(-1).trigger, 'chain');
  assert.notEqual(first.id, second.id);
});

test('a revive burst goes out as channel messages recorded without a reference', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  world.llm.respondWith('anyone around<split>hello');
  await world.ready();
  await world.emitMessage({ author: 'alice', content: 'who wants lunch', timestamp: BASE_TIME });
  await world.advance(3 * 3_600_000 + 600_000);
  assert.deepEqual(world.discord.channel.sent.map((p) => p.content), ['anyone around', 'hello']);
  assert.deepEqual(botRows(world).map((r) => [r.trigger, r.reference]), [['revive', null], ['revive', null]]);
  assert.equal(world.discord.channel.typingCalls, 2);
});
