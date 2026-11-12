import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { fakeEmbed } from '../support/fakes/chroma.js';
import { BASE_TIME } from '../support/fixtures.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const userPrompt = (world, index = 0) => world.llm.calls[index].messages[1].content;
const at = (minutes) => BASE_TIME - minutes * MINUTE;

const converse = async (world) => {
  const first = await world.emitMessage({ id: 'c1', author: 'alice', content: 'anyone around', timestamp: at(3) });
  await world.emitMessage({ id: 'c2', author: 'bob', content: 'yeah whats up', timestamp: at(2), reference: first.id });
  await world.emitMessage({ id: 'c3', author: 'dave', content: 'not much here', timestamp: at(1) });
};

test('the reply prompt carries the preceding conversation and names the sender of the target', async (t) => {
  const world = await newWorld(t);
  await converse(world);
  world.setRandom(0);
  await world.emitMessage({ id: 't', author: 'alice', content: 'want to get food', timestamp: BASE_TIME });
  const prompt = userPrompt(world);
  const lines = [
    '[11:57] alice: anyone around',
    '[11:58] bob (replying to alice): yeah whats up',
    '[11:59] dave: not much here',
  ];
  assert.ok(prompt.includes(`${lines.join('\n')}\n\nThe user has just received this message from "alice": "want to get food".`));
  assert.ok(prompt.includes('Here is the recent conversation in the channel, oldest first, for context:'));
});

test('no earlier history means no transcript section', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.emitMessage({ author: 'alice', content: 'want to get food' });
  assert.ok(!userPrompt(world).includes('recent conversation'));
  assert.match(userPrompt(world), /received this message from "alice": "want to get food"/);
});

test('a failing history fetch logs a warning and the reply is still sent without a transcript', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.discord.channel.messages.setFailing(new Error('missing access'));
  world.addHistory({ author: 'alice', content: 'earlier line', timestamp: at(5) });
  const message = await world.emitMessage({ author: 'alice', content: 'want to get food' });
  assert.equal(message.replies.length, 1);
  assert.ok(!userPrompt(world).includes('recent conversation'));
  assert.ok(world.logs.warn.length >= 1);
  assert.deepEqual(world.errors, []);
});

test('a previous bot reply appears under its persona with its stored content; unknown bot messages do not', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith('lol <gif! cat>');
  const first = await world.emitMessage({ id: 'h1', author: 'alice', content: 'first thing said', timestamp: at(2) });
  const persona = first.replies[0].embeds.at(-1).data.author.name;
  world.addHistory({ author: 'robot', bot: true, content: 'other bot noise', timestamp: at(1) });
  world.discord.channel.history.push({
    id: 'orphan', author: { id: 'bot-user', bot: true }, content: 'no row', embeds: [], createdTimestamp: at(1),
  });
  world.llm.respondWith('plain');
  await world.advance(10 * MINUTE);
  await world.emitMessage({ id: 'h2', author: 'alice', content: 'second thing said', timestamp: world.now() });
  const prompt = userPrompt(world, 1);
  assert.ok(prompt.includes(`${persona} (replying to alice): lol <gif! cat>`), prompt);
  assert.ok(!prompt.includes('other bot noise'));
  assert.ok(!prompt.includes('no row'));
});

test('messages older than the age window do not appear', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.addHistory({ author: 'alice', content: 'ancient history', timestamp: BASE_TIME - 6 * HOUR - MINUTE });
  world.addHistory({ author: 'bob', content: 'recent history', timestamp: at(1) });
  await world.emitMessage({ author: 'alice', content: 'want to get food' });
  assert.ok(!userPrompt(world).includes('ancient history'));
  assert.ok(userPrompt(world).includes('bob: recent history'));
});

test('mentions are transformed, long lines cut, mention-only lines skipped, and replies outside the window have no suffix', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.addHistory({ author: 'alice', content: '<@222>', timestamp: at(4) });
  world.addHistory({ author: 'bob', content: 'ping <@111> now', timestamp: at(3), reference: 'gone' });
  world.addHistory({ author: 'carol', content: 'y'.repeat(400), timestamp: at(2) });
  await world.emitMessage({ author: 'alice', content: 'want to get food' });
  const prompt = userPrompt(world);
  assert.ok(prompt.includes('bob: ping @alice now\n'));
  assert.ok(!prompt.includes('alice: @bob'));
  assert.ok(prompt.includes(`carol: ${'y'.repeat(300)}…\n`));
  assert.ok(!prompt.includes('replying to'));
});

test('a short target is embedded together with the last two transcript lines; a long one alone', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.addHistory({ author: 'alice', content: 'are we still going friday', timestamp: at(3) });
  world.addHistory({ author: 'bob', content: 'i cant make it', timestamp: at(2) });
  const queries = () => world.chroma.collection('message_embeddings').queries;
  await world.emitMessage({ author: 'alice', content: 'whyyy', timestamp: at(1) });
  assert.deepEqual(queries().at(-1).queryEmbeddings[0], fakeEmbed('are we still going friday\ni cant make it\nwhyyy'));
  const long = 'z'.repeat(40);
  await world.advance(10 * MINUTE);
  await world.emitMessage({ author: 'alice', content: long, timestamp: world.now() });
  assert.deepEqual(queries().at(-1).queryEmbeddings[0], fakeEmbed(long));
});

test('the command trigger uses the history before the selected target, not before now', async (t) => {
  const world = await newWorld(t);
  world.addHistory({ author: 'alice', content: 'before the target', timestamp: at(5) });
  const target = world.addHistory({ author: 'bob', content: 'selected target message', timestamp: at(4) });
  world.addHistory({ author: 'carol', content: 'after the target', timestamp: at(3) });
  const interaction = await world.openReplyCommand({ target });
  await interaction.submit({ author: 'dave' });
  const prompt = userPrompt(world);
  assert.ok(prompt.includes('alice: before the target'));
  assert.ok(!prompt.includes('after the target'));
  assert.match(prompt, /received this message from "bob": "selected target message"/);
});

test('reply examples pair a similar past reply with the message it answered; Chroma-only rows have no parent', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.seed([
    { id: 'e1', author: 'dave', content: 'anyone up for food', timestamp: at(500) },
    { id: 'e2', author: 'bob', content: 'im down, where', timestamp: at(499), reference: 'e1' },
  ]);
  world.chroma.collection('message_reply_embeddings').seed([
    { id: 'ghost', document: 'only in chroma', metadata: { author: 'bob', timestamp: at(498) } },
  ]);
  await world.emitMessage({ author: 'alice', content: 'anyone up for food', timestamp: BASE_TIME });
  const prompt = userPrompt(world);
  assert.ok(prompt.includes('{"them":"anyone up for food","you":"im down, where"}'), prompt);
  assert.ok(prompt.includes('{"you":"only in chroma"}'), prompt);
});
