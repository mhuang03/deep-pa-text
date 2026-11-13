import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationGenerator } from '../../../src/llm/conversationGenerator.js';
import { SYSTEM_PROMPT, CONVERSATION_OPENER_SYSTEM_PROMPT } from '../../../src/llm/prompts.js';
import { loadConfig } from '../../../src/config.js';

const NOW = Date.parse('2026-11-12T18:00:00Z');
const BUCKETS = { replies: [], similar: ['hiking is fun'], gifs: [], other: [], frequent: [] };

const setup = ({ buckets = BUCKETS, examples = ['old one'], starters = ['anyone around'] } = {}) => {
  const log = { completes: [], replyCalls: [], reviveCalls: [] };
  const config = loadConfig({});
  const generator = createConversationGenerator({
    complete: async (...args) => { log.completes.push(args); return { response: 'generated', parts: ['generated'] }; },
    retriever: {
      retrieveForReply: async (...args) => { log.replyCalls.push(args); return buckets; },
      retrieveForRevive: async (...args) => { log.reviveCalls.push(args); return examples; },
    },
    userDirectory: { nameOf: (name) => `Name of ${name}` },
    inputs: { recentBotMessages: () => ['bot said'], burstRate: () => 0, starters: () => starters },
    config,
  });
  return { generator, log, config };
};

const conversation = (extra = {}) => ({
  id: 'c1', topic: 'Weekend plans', premise: 'A hike is floated.', participants: ['alice', 'bob'], turns: [],
  turnIndex: 0, remaining: 3, isLast: false, situation: { nowMs: NOW, quietMs: 3 * 3600000 }, ...extra,
});

const TARGET = { id: 'm1', author: 'alice', content: 'who is up for a hike', timestamp: NOW + 5000 };

test('the opener retrieves for the speaker with the topic as record and query, and completes with the opener prompt', async () => {
  const { generator, log } = setup();
  assert.deepEqual(await generator.generateConversationTurn('bob', null, conversation()), { response: 'generated', parts: ['generated'] });
  assert.deepEqual(log.replyCalls, [[
    'bob',
    { id: 'c1', author: '', content: 'Weekend plans. A hike is floated.', timestamp: NOW },
    { queryText: 'Weekend plans. A hike is floated.' },
  ]]);
  assert.deepEqual(log.reviveCalls, [['bob']]);
  assert.equal(log.completes[0][1], CONVERSATION_OPENER_SYSTEM_PROMPT);
});

test('the opener prompt has the brief, the situation, the starters, the topic examples and the past examples', async () => {
  const { generator, log } = setup();
  await generator.generateConversationTurn('bob', null, conversation());
  const prompt = log.completes[0][0];
  assert.match(prompt, /The user you are emulating has username "bob", and their real name is "Name of bob"\./);
  assert.match(prompt, /between alice, bob\. It is about: Weekend plans\. A hike is floated\./);
  assert.match(prompt, /You are starting it\. Write the message that opens the conversation\./);
  assert.match(prompt, /It is Thursday 12:00 PM\. The channel has been quiet for about 3 hours\./);
  assert.match(prompt, /\["anyone around"\]/);
  assert.match(prompt, /about similar things:\n\["hiking is fun"\]/);
  assert.match(prompt, /sent in the past:\n\["old one"\]/);
  assert.match(prompt, /\["bot said"\]/);
  assert.ok(!prompt.includes('just received this message'), 'the opener has no target section');
});

test('past examples that repeat a starter or a topic example are left out', async () => {
  const { generator, log } = setup({ examples: ['Anyone   around', 'HIKING is fun', 'fresh'], starters: ['anyone around'] });
  await generator.generateConversationTurn('bob', null, conversation());
  const prompt = log.completes[0][0];
  assert.match(prompt, /sent in the past:\n\["fresh"\]/);
});

test('a later turn retrieves with the previous turn as record and a query built from the earlier turns', async () => {
  const { generator, log } = setup();
  const turns = [
    { speaker: 'carol', content: 'morning all everyone', timestamp: NOW - 1000 },
    { speaker: 'alice', content: 'who is up for a hike', timestamp: NOW + 5000 },
  ];
  const short = { ...TARGET, content: 'why' };
  await generator.generateConversationTurn('bob', short, conversation({ turns: [...turns.slice(0, 1), { ...turns[1], content: 'why' }], turnIndex: 1 }));
  // A short target borrows the lines before it (queryContextMessages 2, here one earlier turn).
  assert.deepEqual(log.replyCalls, [['bob', short, { queryText: 'morning all everyone\nwhy' }]]);
});

test('a long target is its own query', async () => {
  const { generator, log } = setup();
  const turns = [{ speaker: 'alice', content: TARGET.content, timestamp: TARGET.timestamp }];
  await generator.generateConversationTurn('bob', TARGET, conversation({ turns, turnIndex: 1 }));
  assert.deepEqual(log.replyCalls[0][2], { queryText: TARGET.content });
  assert.equal(log.reviveCalls.length, 0);
});

test('a later turn uses the ordinary system prompt, puts the earlier turns in the transcript and the last as the target', async () => {
  const { generator, log } = setup();
  const turns = [
    { speaker: 'carol', content: 'morning all', timestamp: NOW - 60000 },
    { speaker: 'alice', content: 'who is up for a hike', timestamp: NOW },
  ];
  await generator.generateConversationTurn('bob', TARGET, conversation({ turns, turnIndex: 2, remaining: 1 }));
  const [prompt, system] = log.completes[0];
  assert.equal(system, SYSTEM_PROMPT);
  assert.match(prompt, /Here is the recent conversation in the channel, oldest first, for context:\n\[11:59\] carol: morning all\n\nThe user has just received this message from "alice": "who is up for a hike"\./);
  assert.equal((prompt.match(/who is up for a hike/g) ?? []).length, 1, 'the target is not repeated in the transcript');
  assert.match(prompt, /1 more messages follow yours\./);
});

test('the last turn tells the model nobody replies', async () => {
  const { generator, log } = setup();
  const turns = [{ speaker: 'alice', content: TARGET.content, timestamp: NOW }];
  await generator.generateConversationTurn('bob', TARGET, conversation({ turns, turnIndex: 1, remaining: 0, isLast: true }));
  assert.match(log.completes[0][0], /Nobody replies after this message, so do not ask the others a question\./);
});

test('a second turn has no transcript section because nothing came before the target', async () => {
  const { generator, log } = setup();
  const turns = [{ speaker: 'alice', content: TARGET.content, timestamp: NOW }];
  await generator.generateConversationTurn('bob', TARGET, conversation({ turns, turnIndex: 1 }));
  assert.ok(!log.completes[0][0].includes('recent conversation in the channel'));
});

test('a burst turn is shown on one line in the transcript', async () => {
  const { generator, log } = setup();
  const turns = [
    { speaker: 'carol', content: 'first part\nsecond part', timestamp: NOW - 60000 },
    { speaker: 'alice', content: TARGET.content, timestamp: NOW },
  ];
  await generator.generateConversationTurn('bob', TARGET, conversation({ turns, turnIndex: 2 }));
  assert.match(log.completes[0][0], /carol: first part second part/);
});

test('long transcript entries are cut to the configured entry length', async () => {
  const { generator, log, config } = setup();
  const turns = [
    { speaker: 'carol', content: 'x'.repeat(config.context.maxEntryChars + 50), timestamp: NOW - 60000 },
    { speaker: 'alice', content: TARGET.content, timestamp: NOW },
  ];
  await generator.generateConversationTurn('bob', TARGET, conversation({ turns, turnIndex: 2 }));
  assert.ok(log.completes[0][0].includes(`${'x'.repeat(config.context.maxEntryChars)}…`));
});

test('propagates a retrieval failure', async () => {
  const failing = createConversationGenerator({
    complete: async () => ({}), retriever: { retrieveForReply: async () => { throw new Error('chroma down'); } },
    userDirectory: { nameOf: () => 'x' }, inputs: { recentBotMessages: () => [], burstRate: () => 0, starters: () => [] },
    config: loadConfig({}),
  });
  await assert.rejects(failing.generateConversationTurn('bob', null, conversation()), /chroma down/);
});
