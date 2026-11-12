import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplyGenerator } from '../../../src/llm/replyGenerator.js';
import { SYSTEM_PROMPT } from '../../../src/llm/prompts.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});
const buckets = { replies: [], similar: ['s'], gifs: [], other: ['o'] };

const setup = () => {
  const calls = { complete: [], retrieve: [] };
  const generator = createReplyGenerator({
    complete: async (...args) => { calls.complete.push(args); return { response: 'done' }; },
    retriever: { retrieveForReply: async (...args) => { calls.retrieve.push(args); return buckets; } },
    userDirectory: { nameOf: (u) => `Name of ${u}` },
    inputs: { recentBotMessages: () => ['recent'], burstRate: () => 0, starters: () => [] },
    config,
  });
  return { generator, calls };
};
const record = { id: 'r', author: 'alice', content: 'hi', timestamp: 5 };

test('a plain reply retrieves with the transcript-aware query and completes with the default system prompt', async () => {
  const { generator, calls } = setup();
  const result = await generator.generateReply('bob', record, { transcript: [{ speaker: 'alice', content: 'earlier line', timestamp: 1, replyTo: null }] });
  assert.deepEqual(result, { response: 'done' });
  assert.equal(calls.retrieve[0][2].queryText, 'earlier line\nhi');
  const [user, system, turns] = calls.complete[0];
  assert.match(user, /earlier line/);
  assert.equal(system, undefined);
  assert.equal(turns, undefined);
});

test('a missing context behaves as an empty transcript', async () => {
  const { generator, calls } = setup();
  await generator.generateReply('bob', record);
  assert.equal(calls.retrieve[0][2].queryText, 'hi');
});

test('a chain reply sends the earlier turns as chat turns and the chain prompt as user text', async () => {
  const { generator, calls } = setup();
  const turns = [
    { speaker: 'bob', content: 'bot said', isPersona: true },
    { speaker: 'alice', content: 'hi', isPersona: false },
  ];
  await generator.generateReply('bob', record, { chain: { turns } });
  const [user, system, passed] = calls.complete[0];
  assert.equal(system, SYSTEM_PROMPT);
  assert.equal(passed, turns);
  assert.doesNotMatch(user, /bot said/);
  assert.equal(calls.retrieve[0][2].queryText, 'bot said\nhi');
});
