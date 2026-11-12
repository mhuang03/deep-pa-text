import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator } from '../../../src/llm/generator.js';
import { SYSTEM_PROMPT, REVIVE_SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from '../../../src/llm/prompts.js';

import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});
const buckets = { replies: [{ you: 'r', them: 'q' }], similar: ['s1', 's2'], gifs: ['g'], other: ['o'] };

const setup = ({
  retrieverError = null, chatError = null, recent = [], recentError = null, starterRows = [], starterError = null,
  examples = ['x', 'y'],
} = {}) => {
  const warnings = [];
  const recentCalls = [];
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
      return examples;
    },
  };
  const userDirectory = { nameOf: (u) => ({ alice: 'Alice Example' })[u] };
  const botMessageStore = {
    recent: (args) => {
      recentCalls.push(args);
      if (recentError) throw recentError;
      return recent;
    },
  };
  const starterCalls = [];
  const messageStore = {
    randomStarters: (args) => {
      starterCalls.push(args);
      if (starterError) throw starterError;
      return starterRows;
    },
  };
  const logger = { warn: (line) => warnings.push(line) };
  const generator = createGenerator({
    chatClient, retriever, userDirectory, botMessageStore, messageStore, config, logger,
  });
  return { calls, warnings, recentCalls, starterCalls, generator };
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
  const positions = ['[{"them":"q","you":"r"}]', '["s1","s2"]', '["g"]', '["o"]'].map((s) => user.indexOf(s));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(positions.every((p) => p > 0));
});

test('an unknown persona renders undefined as the name', async () => {
  const { calls, generator } = setup();
  await generator.generateReply('ghost', record);
  assert.match(calls.chat[0].user, /real name is "undefined"/);
});

test('generateRevive without context builds the minimal prompt under the revive system prompt', async () => {
  const { calls, generator } = setup();
  assert.equal(await generator.generateRevive('alice'), 'raw response');
  assert.deepEqual(calls.revive, [['alice']]);
  assert.deepEqual(calls.chat, [{
    system: REVIVE_SYSTEM_PROMPT,
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
    botMessageStore: { recent: () => [] },
    messageStore: { randomStarters: () => [] },
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

const RECENT = [{ content: 'newest bot line' }, { content: 'older bot line' }];

test('replies and revives pass the recent bot messages, newest first, into the prompt', async () => {
  const { calls, recentCalls, generator } = setup({ recent: RECENT });
  await generator.generateReply('alice', record);
  await generator.generateRevive('alice');
  assert.deepEqual(recentCalls, [{ limit: config.retrieval.recentBotMessages }, { limit: config.retrieval.recentBotMessages }]);
  const recentBotMessages = ['newest bot line', 'older bot line'];
  assert.equal(calls.chat[0].user, buildReplyPrompt({
    author: 'alice', name: 'Alice Example', message: 'hello', messageAuthor: 'bob', buckets, transcript: [],
    timeZone: config.context.timeZone, recentBotMessages,
  }));
  assert.equal(calls.chat[1].user, buildRevivePrompt({
    author: 'alice', name: 'Alice Example', examples: ['x', 'y'], recentBotMessages,
    timeZone: config.context.timeZone,
  }));
  assert.match(calls.chat[1].user, /recently sent these messages[^\n]*\n\["newest bot line","older bot line"\]$/);
});

test('a failure to load recent bot messages is logged and treated as none', async () => {
  const { calls, warnings, generator } = setup({ recentError: new Error('db locked') });
  assert.equal(await generator.generateReply('alice', record), 'raw response');
  assert.equal(await generator.generateRevive('alice'), 'raw response');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /db locked/);
  assert.ok(!calls.chat[0].user.includes('recently sent'));
});

test('no bot messages yet means no avoid-repeats section', async () => {
  const { calls, generator } = setup();
  await generator.generateReply('alice', record);
  assert.ok(!calls.chat[0].user.includes('recently sent'));
});

test('generateRevive passes starters, transcript, quiet time and the clock into the prompt', async () => {
  const { calls, starterCalls, generator } = setup({
    starterRows: ['Yo', 'yoooo', 'hey all', 'a', 'b'], examples: ['x', 'HEY ALL', 'y'],
  });
  const transcript = [{ id: '1', speaker: 'bob', content: 'hi', timestamp: 5, replyTo: null }];
  const nowMs = Date.UTC(2026, 10, 12, 21, 10);
  await generator.generateRevive('alice', { transcript, quietMs: 7200000, nowMs });
  assert.deepEqual(starterCalls, [{
    author: 'alice', minGapMs: config.revive.starterGapMs,
    limit: config.revive.starterSamples * config.retrieval.overFetchFactor,
  }]);
  assert.equal(calls.chat[0].user, buildRevivePrompt({
    author: 'alice', name: 'Alice Example', examples: ['x', 'y'], starters: ['Yo', 'hey all', 'a', 'b'],
    transcript, quietMs: 7200000, nowMs, timeZone: config.context.timeZone,
  }));
});

test('starters are cut to starterSamples after deduplication', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `starter number ${i}`);
  const { calls, generator } = setup({ starterRows: [...rows, 'STARTER NUMBER 0'] });
  await generator.generateRevive('alice');
  const line = calls.chat[0].user.split('\n').find((l) => l.startsWith('["starter'));
  assert.deepEqual(JSON.parse(line), rows.slice(0, config.revive.starterSamples));
});

test('a starters failure is logged and the revive is built without starters', async () => {
  const { calls, warnings, generator } = setup({ starterError: new Error('db locked') });
  assert.equal(await generator.generateRevive('alice'), 'raw response');
  assert.match(warnings[0], /db locked/);
  assert.ok(!calls.chat[0].user.includes('start a conversation'));
  assert.ok(calls.chat[0].user.includes('["x","y"]'));
});
