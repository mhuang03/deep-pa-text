import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator } from '../../../src/llm/generator.js';
import { SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from '../../../src/llm/prompts.js';

import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});
const buckets = { replies: ['r'], similar: ['s1', 's2'], gifs: ['g'], other: ['o'] };

const setup = ({ retrieverError = null, chatError = null } = {}) => {
  const calls = { chat: [], reply: [], revive: [] };
  const chatClient = {
    complete: async (req) => {
      calls.chat.push(req);
      if (chatError) throw chatError;
      return '  raw response ';
    },
  };
  const retriever = {
    retrieveForReply: async (...args) => {
      calls.reply.push(args);
      if (retrieverError) throw retrieverError;
      return buckets;
    },
    retrieveForRevive: async (...args) => {
      calls.revive.push(args);
      return ['x', 'y'];
    },
  };
  const userDirectory = { nameOf: (u) => ({ alice: 'Alice Example' })[u] };
  return { calls, generator: createGenerator({ chatClient, retriever, userDirectory, config }) };
};
const record = { author: 'bob', content: 'hello', timestamp: 5 };

test('generateReply assembles the prompt and returns the sanitised response', async () => {
  const { calls, generator } = setup();
  assert.equal(await generator.generateReply('alice', record), 'raw response');
  assert.deepEqual(calls.reply, [['alice', record, { queryText: 'hello' }]]);
  assert.deepEqual(calls.chat, [{
    system: SYSTEM_PROMPT,
    user: buildReplyPrompt({ author: 'alice', name: 'Alice Example', message: 'hello', messageAuthor: 'bob', buckets, transcript: [],
      timeZone: config.context.timeZone,
    }),
  }]);
});

test('a transcript is rendered in the prompt and short targets borrow its last lines for the query', async () => {
  const { calls, generator } = setup();
  const transcript = ['one', 'two', 'three'].map((content, i) => ({
    id: String(i), speaker: 'carol', content, timestamp: Date.UTC(2026, 0, 1, 12, i), replyTo: null,
  }));
  await generator.generateReply('alice', { ...record, content: 'why' }, { transcript });
  assert.deepEqual(calls.reply[0][2], { queryText: 'two\nthree\nwhy' });
  assert.match(calls.chat[0].user, /\[06:00\] carol: one\n\[06:01\] carol: two\n\[06:02\] carol: three/);
  assert.match(calls.chat[0].user, /received this message from "bob": "why"\./);
});

test('the reply prompt lists buckets in BUCKET_ORDER', async () => {
  const { calls, generator } = setup();
  await generator.generateReply('alice', record);
  const user = calls.chat[0].user;
  const positions = ['["r"]', '["s1","s2"]', '["g"]', '["o"]'].map((s) => user.indexOf(s));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(positions.every((p) => p > 0));
});

test('an unknown persona renders undefined as the name', async () => {
  const { calls, generator } = setup();
  await generator.generateReply('ghost', record);
  assert.match(calls.chat[0].user, /real name is "undefined"/);
});

test('generateRevive builds the contextless prompt', async () => {
  const { calls, generator } = setup();
  assert.equal(await generator.generateRevive('alice'), 'raw response');
  assert.deepEqual(calls.revive, [['alice']]);
  assert.deepEqual(calls.chat, [{
    system: SYSTEM_PROMPT,
    user: buildRevivePrompt({ author: 'alice', name: 'Alice Example', examples: ['x', 'y'] }),
  }]);
});

test('retriever errors propagate and no chat request is made', async () => {
  const { calls, generator } = setup({ retrieverError: new Error('search failed') });
  await assert.rejects(generator.generateReply('alice', record), /search failed/);
  assert.equal(calls.chat.length, 0);
});

test('chat errors propagate', async () => {
  const { generator } = setup({ chatError: new Error('llm down') });
  await assert.rejects(generator.generateReply('alice', record), /llm down/);
  await assert.rejects(generator.generateRevive('alice'), /llm down/);
});

const setupWith = (completion) => {
  const generator = createGenerator({
    chatClient: { complete: async () => completion },
    retriever: { retrieveForReply: async () => buckets, retrieveForRevive: async () => [] },
    userDirectory: { nameOf: () => 'Alice Example' },
    config,
  });
  return generator;
};

test('sanitises replies and revives', async () => {
  const generator = setupWith('"line one\\nline two"');
  assert.equal(await generator.generateReply('alice', record), 'line one\nline two');
  assert.equal(await generator.generateRevive('alice'), 'line one\nline two');
});

test('throws when the sanitised response is empty', async () => {
  const generator = setupWith('  "" ');
  await assert.rejects(generator.generateReply('alice', record), /LLM returned an empty response/);
  await assert.rejects(generator.generateRevive('alice'), /LLM returned an empty response/);
});
