import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { createWorld } from '../support/world.js';
import { fakeEmbed } from '../support/fakes/chroma.js';
import { BASE_TIME } from '../support/fixtures.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const HELLO = 'hello there friends';

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const botRows = (world) => world.sqlite.all('SELECT * FROM bot_messages ORDER BY rowid');
const lastBot = (world) => botRows(world).at(-1);
const lastRequest = (world) => world.llm.calls.at(-1).messages;
const roles = (messages) => messages.map((m) => m.role);
const personaOf = (message) => message.replies[0].embeds.at(-1).data.author.name;
const numberedReplies = (world) => {
  let count = 0;
  world.llm.respondWith(() => `bot says ${++count}`);
};

// An auto reply to HELLO, after which the random roll is set so nothing else replies by chance.
const startThread = async (world, { author = 'alice' } = {}) => {
  numberedReplies(world);
  const root = await world.emitMessage({ author, content: HELLO });
  world.setRandom(0.99);
  return root;
};

const replyToBot = (world, content, { author = 'alice', row = lastBot(world) } = {}) =>
  world.emitMessage({ author, content, reference: row.id });

test('a reply to a bot message is answered by the same persona despite the roll and the rate limit', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await startThread(world);
  const first = lastBot(world);
  const reply = await replyToBot(world, 'why');
  assert.equal(reply.replies.length, 1);
  assert.equal(personaOf(reply), first.persona);
  const row = lastBot(world);
  assert.deepEqual([row.trigger, row.persona, row.reference], ['chain', first.persona, reply.id]);
  assert.deepEqual(roles(lastRequest(world)), ['system', 'user', 'assistant', 'user']);
  assert.match(lastRequest(world)[1].content, /alice: hello there friends$/);
  assert.equal(lastRequest(world)[2].content, 'bot says 1');
  assert.equal(lastRequest(world)[3].content, 'alice: why');
});

test('a short reply to a bot message is answered while the same text elsewhere is not', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await startThread(world);
  const calls = world.llm.calls.length;
  const plain = await world.emitMessage({ author: 'alice', content: 'why' });
  assert.equal(plain.replies.length, 0);
  assert.equal(world.llm.calls.length, calls);
  const reply = await replyToBot(world, 'why');
  assert.equal(reply.replies.length, 1);
});

test('bot, human, bot, human alternates assistant and user turns', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await startThread(world);
  await replyToBot(world, 'why');
  await replyToBot(world, 'and then');
  assert.deepEqual(roles(lastRequest(world)), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(lastRequest(world).slice(2).map((m) => m.content), [
    'bot says 1', 'alice: why', 'bot says 2', 'alice: and then',
  ]);
});

test('a thread rooted at a revive starts with the assistant turn', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  numberedReplies(world);
  await world.advance(3 * HOUR + 10 * MINUTE);
  const revive = lastBot(world);
  assert.equal(revive.trigger, 'revive');
  const reply = await replyToBot(world, 'huh');
  assert.equal(reply.replies.length, 1);
  assert.equal(personaOf(reply), revive.persona);
  assert.deepEqual(roles(lastRequest(world)), ['system', 'user', 'assistant', 'user']);
  assert.equal(lastRequest(world)[3].content, 'alice: huh');
});

test('two humans in a row merge into one user message with both prefixed lines', async (t) => {
  const world = await newWorld(t);
  numberedReplies(world);
  const first = await world.emitMessage({ author: 'dave', content: 'anyone free tonight' });
  world.setRandom(0);
  await world.emitMessage({ author: 'alice', content: 'i might be free', reference: first.id });
  world.setRandom(0.99);
  await replyToBot(world, 'which one');
  const user = lastRequest(world)[1].content;
  assert.match(user, /dave: anyone free tonight\n\nalice: i might be free$/);
  assert.deepEqual(roles(lastRequest(world)), ['system', 'user', 'assistant', 'user']);
});

test('a bot message of another persona in the thread is a user turn named after it', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await startThread(world);
  const first = lastBot(world);
  const why = await replyToBot(world, 'why do you say that');
  const other = first.persona === 'dave' ? 'carol' : 'dave';
  const interaction = await world.openReplyCommand({ target: why });
  await interaction.submit({ author: other });
  world.setRandom(0.99);
  await replyToBot(world, 'huh');
  const messages = lastRequest(world);
  assert.equal(messages.at(-1).content, 'alice: huh');
  assert.ok(messages.some((m) => m.role === 'user' && m.content.includes(`${first.persona}: bot says 1`)));
  assert.equal(botRows(world).at(-1).persona, other);
});

test('a persona missing from the user directory is not a chain and the normal flow applies', async (t) => {
  const world = await newWorld(t, { random: 0 });
  numberedReplies(world);
  world.sqlite.all(
    "INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger) VALUES ('ghost', 'zed', 'boo', 1, NULL, 'auto')",
  );
  const reply = await world.emitMessage({ content: 'is anyone there', reference: 'ghost' });
  assert.equal(reply.replies.length, 1);
  assert.equal(botRows(world).at(-1).trigger, 'auto');
});

async function growThread(world, rounds) {
  await startThread(world);
  world.setRandom(0);
  for (let i = 0; i < rounds; i += 1) await replyToBot(world, `reply ${i}`);
}

test('with four bot turns the chance is one half: a roll of 0.4 replies and 0.6 does not', async (t) => {
  const hit = await newWorld(t, { random: 0 });
  await growThread(hit, 3);
  assert.equal(botRows(hit).length, 4);
  hit.setRandom(0.4);
  assert.equal((await replyToBot(hit, 'more')).replies.length, 1);
  await hit.close();

  const miss = await newWorld(t, { random: 0 });
  await growThread(miss, 3);
  const calls = miss.llm.calls.length;
  miss.setRandom(0.6);
  assert.equal((await replyToBot(miss, 'more')).replies.length, 0);
  assert.equal(miss.llm.calls.length, calls);
  assert.equal(botRows(miss).length, 4);
});

test('a long thread stops at the bot message cap and the prompt holds only the last twelve turns', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await growThread(world, 6);
  assert.equal(botRows(world).length, 7);
  assert.equal(lastRequest(world).length, 14);
  assert.equal(lastRequest(world)[2].role, 'assistant');
  assert.ok(!JSON.stringify(lastRequest(world)).includes(HELLO));
  await replyToBot(world, 'one more');
  assert.equal(botRows(world).length, 8);
  const calls = world.llm.calls.length;
  const capped = await replyToBot(world, 'and again');
  assert.equal(capped.replies.length, 0);
  assert.equal(world.llm.calls.length, calls);
  assert.ok(world.logs.log.some((args) => String(args[0]).includes('chain-limit')));
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a second reply while a chain reply is generating is declined without an LLM call', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await startThread(world);
  const parent = lastBot(world);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.llm.respondWith(() => gate);
  const first = world.addHistory({ author: 'alice', content: 'why', reference: parent.id });
  world.discord.client.emit(Events.MessageCreate, first);
  for (let i = 0; i < 50 && world.llm.calls.length < 2; i += 1) await tick();
  const second = world.addHistory({ author: 'dave', content: 'me too', reference: parent.id });
  world.discord.client.emit(Events.MessageCreate, second);
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(world.llm.calls.length, 2);
  release('late answer');
  await world.settle();
  assert.equal(first.replies.length, 1);
  assert.equal(second.replies.length, 0);
  assert.ok(world.logs.log.some((args) => String(args[0]).includes('chain-busy')));
  const third = await replyToBot(world, 'ok');
  assert.equal(third.replies.length, 1);
});

test('a chain reply arms the rate limit for unrelated messages', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  numberedReplies(world);
  await world.advance(3 * HOUR + 10 * MINUTE);
  await replyToBot(world, 'huh');
  world.setRandom(0);
  await world.advance(MINUTE);
  const calls = world.llm.calls.length;
  const unrelated = await world.emitMessage({ content: 'something unrelated entirely' });
  assert.equal(unrelated.replies.length, 0);
  assert.equal(world.llm.calls.length, calls);
});

test('a revive still fires 3 hours after a human replied to a bot message', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  numberedReplies(world);
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.discord.channel.sent.length, 1);
  const reply = await replyToBot(world, 'huh');
  assert.equal(reply.replies.length, 1);
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.discord.channel.sent.length, 2);
});

test('a parent only resolvable through its embed is fetched once and forms a two-turn chain', async (t) => {
  const world = await newWorld(t);
  numberedReplies(world);
  const old = await world.discord.channel.send({ content: 'old words', embeds: [{ author: { name: 'bob' } }] });
  const reply = await world.emitMessage({ author: 'alice', content: 'why', reference: old.id });
  assert.equal(reply.referenceFetches, 1);
  assert.equal(reply.replies.length, 1);
  assert.equal(personaOf(reply), 'bob');
  assert.deepEqual(lastRequest(world).slice(2), [
    { role: 'assistant', content: 'old words' }, { role: 'user', content: 'alice: why' },
  ]);
});

test('a reply to a stored human message and a message without a reference fetch nothing', async (t) => {
  const world = await newWorld(t);
  const human = await world.emitMessage({ author: 'dave', content: HELLO });
  const reply = await world.emitMessage({ author: 'alice', content: 'sure thing', reference: human.id });
  const plain = await world.emitMessage({ author: 'alice', content: 'no reference here' });
  assert.deepEqual([human.referenceFetches, reply.referenceFetches, plain.referenceFetches], [0, 0, 0]);
});

test('a failed reference fetch is tolerated and the message takes the normal flow', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const reply = await world.emitMessage({ content: 'replying to nothing', reference: 'vanished' });
  assert.equal(reply.referenceFetches, 1);
  assert.equal(reply.replies.length, 1);
  assert.equal(botRows(world)[0].trigger, 'auto');
  assert.deepEqual(world.errors, []);
});

test('a short message borrows the thread for its query and appears once', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await startThread(world);
  await replyToBot(world, 'why');
  const queries = world.chroma.collection('message_embeddings').queries;
  assert.deepEqual(queries.at(-1).queryEmbeddings[0], fakeEmbed(`${HELLO}\nbot says 1\nwhy`));
});

test('CHAIN_REPLIES=false disables chain replies but the corpus rule still applies', async (t) => {
  const world = await newWorld(t, { random: 0, env: { CHAIN_REPLIES: 'false' } });
  await startThread(world);
  const calls = world.llm.calls.length;
  const reply = await replyToBot(world, 'why do you say so');
  assert.equal(reply.replies.length, 0);
  assert.equal(world.llm.calls.length, calls);
  const stored = world.sqlite.get('SELECT reference FROM filtered_messages WHERE id = ?', reply.id);
  assert.equal(stored.reference, null);
});

test('a human reply to a bot message is stored without a reference or reply embedding', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await startThread(world, { author: 'dave' });
  const reply = await replyToBot(world, 'why do you say that');
  const raw = world.sqlite.get('SELECT reference FROM messages WHERE id = ?', reply.id);
  const stored = world.sqlite.get('SELECT reference FROM filtered_messages WHERE id = ?', reply.id);
  assert.equal(raw.reference, lastBotBefore(world, reply).id);
  assert.equal(stored.reference, null);
  assert.equal(world.chroma.collection('message_reply_embeddings').upserts.length, 0);
});

const lastBotBefore = (world, reply) =>
  botRows(world).find((row) => row.id === reply.reference.messageId);
