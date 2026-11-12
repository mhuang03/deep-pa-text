import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const T0 = BASE_TIME - 48 * HOUR;

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const seedHistory = (world) => world.seed([
  { id: 'h1', author: 'dave', content: 'morning everyone anyone up', timestamp: T0 },
  { id: 'h2', author: 'bob', content: 'yeah im here dave', timestamp: T0 + MINUTE },
  { id: 'h3', author: 'dave', content: 'whats the plan for today', timestamp: T0 + 2 * MINUTE },
  { id: 'h4', author: 'dave', content: 'back after a long silence', timestamp: T0 + 30 * HOUR },
]);

// The JSON list on the line after an intro sentence; list order is random.
const listAfter = (prompt, intro) => {
  const all = prompt.split('\n');
  return JSON.parse(all[all.findIndex((line) => line.startsWith(intro)) + 1]);
};
const STARTERS_INTRO = 'Here are messages this user has sent to start a conversation';
const EXAMPLES_INTRO = 'Here are some examples of messages that the user has sent in the past';

const revivePrompt = async (t) => {
  const world = await newWorld(t);
  await seedHistory(world);
  await world.ready();
  await world.emitMessage({ id: 'tail1', author: 'alice', content: 'who wants lunch', timestamp: BASE_TIME - MINUTE });
  await world.emitMessage({ id: 'tail2', author: 'bob', content: 'not me today', timestamp: BASE_TIME });
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.llm.calls.length, 1);
  return world.llm.calls[0].messages[1].content;
};

test('the revive prompt states the weekday, local time and how long the channel was quiet', async (t) => {
  const prompt = await revivePrompt(t);
  assert.ok(prompt.includes('It is Thursday 3:10 PM. The channel has been quiet for about 3 hours.'), prompt);
});

test('the revive prompt contains the end of the last conversation', async (t) => {
  const prompt = await revivePrompt(t);
  assert.ok(prompt.includes(
    'Here is the end of the last conversation in the channel, oldest first:\n[11:59] alice: who wants lunch\n[12:00] bob: not me today',
  ), prompt);
});

test('starters list the persona conversation openers and not mid-conversation messages', async (t) => {
  const prompt = await revivePrompt(t);
  const starters = listAfter(prompt, STARTERS_INTRO);
  assert.ok(starters.includes('morning everyone anyone up'));
  assert.ok(starters.includes('back after a long silence'));
  assert.ok(!starters.includes('whats the plan for today'));
  assert.ok(prompt.includes('Here are messages this user has sent to start a conversation after the channel had been quiet:'));
});

test('examples hold the persona mid-conversation messages and never the starters', async (t) => {
  const prompt = await revivePrompt(t);
  const examples = listAfter(prompt, EXAMPLES_INTRO);
  assert.deepEqual(examples, ['whats the plan for today']);
});

test('the revive uses the revive system prompt', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: 'hello there friends', timestamp: BASE_TIME });
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.llm.calls[0].messages[0].content, world.subject.REVIVE_SYSTEM_PROMPT);
});

test('a failing history fetch still revives with the time sentence only', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: 'hello there friends', timestamp: BASE_TIME });
  world.discord.channel.messages.setFailing(new Error('missing access'));
  await world.advance(3 * HOUR + 10 * MINUTE);
  const prompt = world.llm.calls[0].messages[1].content;
  assert.ok(prompt.includes('It is Thursday 3:10 PM.\n'));
  assert.ok(!prompt.includes('has been quiet') && !prompt.includes('last conversation'));
  assert.equal(world.discord.channel.sent.length, 1);
});
