import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';
import { GENERATION_FAILED_MESSAGE } from '../../src/discord/replyModal.js';

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const FAILURE_COOLDOWN = MINUTE;
const HELLO = 'hello there friends';
const WHY = 'why do you say that';
const REPLYABLE = 'a replyable message';

const newWorld = async (t, options = { random: 0 }) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const logged = (world, text) => world.logs.log.some((args) => String(args[0]).includes(text));
const insertBot = (world, id, persona = 'bob') => world.sqlite.all(
  `INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger) VALUES ('${id}', '${persona}', 'bot words here', 1, NULL, 'auto')`,
);
const replyTo = (world, id, author) => world.emitMessage({ author, content: WHY, reference: id });

// Wraps the modal wait so a test can observe what the handler did before and after each step.
const watchSubmission = (command) => {
  const watched = { submitted: null };
  const taken = command.awaitModalSubmit;
  command.awaitModalSubmit = async (options) => {
    watched.submitted = await taken(options);
    return watched.submitted;
  };
  return watched;
};

test('two replyable messages 2 s apart while the LLM is held produce one LLM call and one reply', async (t) => {
  const world = await newWorld(t);
  const release = world.llm.hold();
  const first = await world.emitMessage({ content: HELLO });
  await world.advance(2 * SECOND);
  const rollsBefore = world.randomCalls;
  const second = await world.emitMessage({ content: HELLO });
  assert.equal(world.randomCalls, rollsBefore, 'the blocked message consumed no roll');
  assert.ok(logged(world, 'another reply is in flight'));
  release();
  await world.settle();
  assert.equal(world.llm.calls.length, 1);
  assert.equal(first.replies.length, 1);
  assert.equal(second.replies.length, 0);
});

test('the in-flight slot is free again once the reply is delivered, subject to the rate limit', async (t) => {
  const world = await newWorld(t);
  const release = world.llm.hold();
  await world.emitMessage({ content: HELLO });
  release();
  await world.settle();
  const during = await world.emitMessage({ content: HELLO });
  assert.equal(during.replies.length, 0);
  assert.ok(logged(world, 'rate limited'));
  await world.advance(5 * MINUTE);
  assert.equal((await world.emitMessage({ content: HELLO })).replies.length, 1);
});

test('a failed generation releases the slot, cools down for 60 s and then replies again', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith([new Error('llm down'), 'fine now']);
  await world.emitMessage({ content: HELLO });
  await world.advance(SECOND);
  const rollsBefore = world.randomCalls;
  const blocked = await world.emitMessage({ content: HELLO });
  assert.equal(blocked.replies.length, 0);
  assert.equal(world.randomCalls, rollsBefore, 'a cooldown consumes no roll');
  assert.ok(logged(world, 'cooling down'));
  assert.equal(world.llm.calls.length, 1);
  await world.advance(FAILURE_COOLDOWN);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies[0].content, 'fine now');
});

test('a failed generation leaves the miss counter alone', async (t) => {
  const world = await newWorld(t, { random: 0.12 });
  for (let i = 0; i < 11; i += 1) await world.emitMessage({ content: HELLO });
  world.llm.respondWith([new Error('llm down'), 'fine now']);
  await world.emitMessage({ content: HELLO });
  await world.advance(FAILURE_COOLDOWN);
  const next = await world.emitMessage({ content: HELLO });
  assert.equal(next.replies.length, 1, 'the escalated chance from 11 misses still applies');
});

test('a retrieval failure mid-reply takes the same cooldown path', async (t) => {
  const world = await newWorld(t);
  world.chroma.collection('message_embeddings').setFailing(new Error('chroma down'), ['query']);
  await world.emitMessage({ content: HELLO });
  assert.equal(world.llm.calls.length, 0);
  world.chroma.collection('message_embeddings').setFailing(null);
  await world.advance(SECOND);
  const blocked = await world.emitMessage({ content: HELLO });
  assert.equal(blocked.replies.length, 0);
  assert.ok(logged(world, 'cooling down'));
  await world.advance(FAILURE_COOLDOWN);
  assert.equal((await world.emitMessage({ content: HELLO })).replies.length, 1);
});

test('a failed persona selection also starts the cooldown', async (t) => {
  const world = await newWorld(t);
  world.chroma.collection('message_reply_embeddings').setFailing(new Error('chroma down'), ['query']);
  await world.emitMessage({ content: HELLO });
  world.chroma.collection('message_reply_embeddings').setFailing(null);
  await world.advance(SECOND);
  assert.equal((await world.emitMessage({ content: HELLO })).replies.length, 0);
  assert.ok(logged(world, 'cooling down'));
});

test('a delivery failure arms the normal rate limit and no failure cooldown', async (t) => {
  const world = await newWorld(t);
  const failing = world.discord.makeMessage({ content: HELLO });
  failing.failReplies(new Error('Unknown Message'));
  world.discord.client.emit('messageCreate', failing);
  await world.settle();
  await world.advance(FAILURE_COOLDOWN + SECOND);
  const blocked = await world.emitMessage({ content: HELLO });
  assert.equal(blocked.replies.length, 0);
  assert.ok(logged(world, 'rate limited'));
  assert.equal(logged(world, 'cooling down'), false);
});

test('a failed auto reply hands the activity back so a revive fires 3 hours after the human message', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  world.llm.respondWith([new Error('llm down'), 'revive words']);
  await world.emitMessage({ content: HELLO });
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.discord.channel.sent.length, 1);
  assert.equal(world.discord.channel.sent[0].content, 'revive words');
});

test('a human message during a failing generation keeps its timestamp as the activity', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  const release = world.llm.hold();
  world.llm.respondWith(new Error('llm down'));
  await world.emitMessage({ content: HELLO });
  await world.advance(2 * HOUR);
  await world.emitMessage({ author: 'bob', content: 'something else entirely' });
  release();
  await world.settle();
  world.llm.respondWith('revive words');
  await world.advance(2 * HOUR + 50 * MINUTE);
  assert.deepEqual(world.discord.channel.sent, [], 'the revive clock restarted at the second human message');
  await world.advance(20 * MINUTE);
  assert.equal(world.discord.channel.sent.length, 1);
});

test('a failed revive restores the activity and is retried only after 30 minutes', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  await world.ready();
  await world.emitMessage({ content: HELLO });
  world.llm.respondWith([new Error('llm down'), 'back again']);
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.llm.calls.length, 1);
  await world.advance(10 * MINUTE);
  assert.equal(world.llm.calls.length, 1);
  await world.advance(10 * MINUTE);
  assert.equal(world.llm.calls.length, 1);
  await world.advance(10 * MINUTE);
  assert.equal(world.llm.calls.length, 2);
  assert.equal(world.discord.channel.sent.length, 1);
});

test('chain replies are never throttled: seven across threads within a minute are all answered', async (t) => {
  const world = await newWorld(t);
  const authors = ['alice', 'bob', 'carol', 'dave', 'alice', 'bob', 'carol'];
  const replies = [];
  for (const [index, author] of authors.entries()) {
    insertBot(world, `b${index}`);
    replies.push(await replyTo(world, `b${index}`, author));
    await world.advance(SECOND);
  }
  assert.deepEqual(replies.map((m) => m.replies.length), [1, 1, 1, 1, 1, 1, 1]);
});

test('the same user replying to bot messages seconds apart is answered every time', async (t) => {
  const world = await newWorld(t);
  ['b1', 'b2', 'b3'].forEach((id) => insertBot(world, id));
  const first = await replyTo(world, 'b1', 'alice');
  await world.advance(3 * SECOND);
  const second = await replyTo(world, 'b2', 'alice');
  const third = await replyTo(world, 'b3', 'alice');
  assert.deepEqual([first, second, third].map((m) => m.replies.length), [1, 1, 1]);
});

test('a chain reply whose send fails arms the rate limit so the next chain reply costs no LLM call', async (t) => {
  const world = await newWorld(t, { random: 0 });
  insertBot(world, 'b1');
  const failing = world.discord.makeMessage({ author: 'alice', content: WHY, reference: 'b1' });
  failing.failReplies(new Error('Unknown Message'));
  world.discord.client.emit('messageCreate', failing);
  await world.settle();
  assert.equal(world.llm.calls.length, 1);
  await world.advance(SECOND);
  const next = await world.emitMessage({ author: 'dave', content: HELLO });
  assert.equal(next.replies.length, 0);
  assert.equal(world.llm.calls.length, 1);
  assert.ok(logged(world, 'rate limited'));
});

test('the command is never limited: the same user twice in a row and three users at once are all answered', async (t) => {
  const world = await newWorld(t);
  const first = await world.openReplyCommand({ target: { content: REPLYABLE }, user: 'alice' });
  await first.submit({ author: 'bob' });
  const second = await world.openReplyCommand({ target: { content: REPLYABLE }, user: 'alice' });
  assert.notEqual(second.modal, null);
  assert.deepEqual(second.replies, []);
  assert.equal((await second.submit({ author: 'bob' })).edits.length, 2);

  const releases = [world.llm.hold(), world.llm.hold(), world.llm.hold()];
  const commands = [];
  for (const user of ['alice', 'bob', 'carol']) {
    commands.push(await world.openReplyCommand({ target: { content: REPLYABLE }, user }));
  }
  const submissions = [];
  for (const command of commands) submissions.push(await command.submit({ author: 'dave' }));
  assert.deepEqual(submissions.map((submitted) => submitted.deferrals.length), [1, 1, 1]);
  releases.forEach((release) => release());
  await world.settle();
  assert.deepEqual(submissions.map((submitted) => submitted.edits.length), [2, 2, 2]);
});

test('the command defers before the embedding for random is requested', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    { id: 't1', author: 'dave', content: REPLYABLE, timestamp: BASE_TIME - 5000 },
    { id: 'r1', author: 'bob', content: 'bob replies to it', timestamp: BASE_TIME - 4000, reference: 't1' },
  ]);
  const { makeMessage, makeReplyCommand } = world.fakes.discord;
  const command = makeReplyCommand({ target: makeMessage({ content: REPLYABLE }), user: 'alice' });
  const watched = watchSubmission(command);
  await world.emitInteraction(command);
  const embedder = world.chroma.embedder;
  const generate = embedder.generate.bind(embedder);
  const deferralsAtEmbed = [];
  embedder.generate = async (texts) => {
    deferralsAtEmbed.push(watched.submitted.deferrals.length);
    return generate(texts);
  };
  const submitted = await command.submit({ author: 'random' });
  assert.ok(deferralsAtEmbed.length >= 1);
  assert.ok(deferralsAtEmbed.every((count) => count === 1), 'every embedding came after deferReply');
  assert.equal(submitted.edits.length, 2);
});

test('a failing embedding for random is reported through editReply after the acknowledgement', async (t) => {
  const world = await newWorld(t);
  world.chroma.embedder.setFailing(new Error('embedding down'));
  const command = await world.openReplyCommand({ target: { content: REPLYABLE }, user: 'alice' });
  const submitted = await command.submit({ author: 'random' });
  assert.equal(submitted.deferrals.length, 1);
  assert.deepEqual(submitted.edits.map((edit) => edit.content), [GENERATION_FAILED_MESSAGE]);
  assert.equal(world.llm.calls.length, 0);
  assert.deepEqual(world.errors, []);
});

test('a deferReply that rejects is logged and sends nothing; the next command works', async (t) => {
  const world = await newWorld(t);
  const first = await world.openReplyCommand({ target: { content: REPLYABLE }, user: 'alice' });
  const failed = await first.submit({ author: 'bob', failDefer: { error: new Error('Unknown interaction') } });
  assert.deepEqual([failed.edits, failed.replies, failed.deferrals], [[], [], []]);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(world.logs.error.length, 1);
  const second = await world.openReplyCommand({ target: { content: REPLYABLE }, user: 'alice' });
  const worked = await second.submit({ author: 'bob' });
  assert.equal(worked.edits.length, 2);
});

test('the webhook display acknowledges ephemerally', async (t) => {
  const world = await newWorld(t, { random: 0, env: { PERSONA_DISPLAY: 'webhook' } });
  const command = await world.openReplyCommand({ target: { content: REPLYABLE }, user: 'alice' });
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual(submitted.deferrals, [{ flags: MessageFlags.Ephemeral }]);
  assert.equal('flags' in submitted.edits[0], false);
});

const THIRTY = Array.from({ length: 30 }, (_, i) => ({ username: `member${i}`, name: `Member ${i}` }));

test('30 users in the directory build a modal with 25 options that includes the default persona', async (t) => {
  const world = await newWorld(t, { random: 0.99, users: THIRTY });
  insertBot(world, 'bot-target', 'member29');
  const target = world.discord.makeMessage({ id: 'bot-target', author: 'deep-pa-text', bot: true, content: '' });
  const command = await world.openReplyCommand({ target, user: 'alice' });
  const options = command.modal.components[1].component.options;
  assert.equal(options.length, 25);
  assert.deepEqual(options.filter((o) => o.default).map((o) => o.value), ['member29']);
  assert.equal(options.at(-1).value, 'random');
  await command.timeout();
});

test('a 5000 character target builds a modal with a 1000 character preview plus an ellipsis', async (t) => {
  const world = await newWorld(t, { random: 0.99, config: { filter: { maxLength: 6000 } } });
  const command = await world.openReplyCommand({ target: { content: 'z'.repeat(5000) }, user: 'alice' });
  assert.equal(command.modal.components[0].content, `**Original message from alice:**\n${'z'.repeat(1000)}…`);
  await command.timeout();
});

test('an embed-mode reply carries failIfNotExists false so a deleted target does not lose it', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies[0].failIfNotExists, false);
});

test('empty model output is retried once: two completions, one reply', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith(['""', 'a real answer']);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(world.llm.calls.length, 2);
  assert.equal(message.replies.length, 1);
  assert.equal(message.replies[0].content, 'a real answer');
});

test('the chain-disabled flow still answers through the normal policy', async (t) => {
  const world = await newWorld(t, { random: 0, env: { CHAIN_REPLIES: 'false' } });
  insertBot(world, 'b1');
  const answered = await replyTo(world, 'b1', 'alice');
  assert.equal(answered.replies.length, 1);
  assert.equal(world.sqlite.all('SELECT trigger FROM bot_messages ORDER BY rowid DESC LIMIT 1')[0].trigger, 'auto');
  world.setRandom(0.99);
  insertBot(world, 'b2');
  await world.advance(5 * MINUTE);
  assert.equal((await replyTo(world, 'b2', 'alice')).replies.length, 0);
  assert.equal(logged(world, 'chain'), false);
});
