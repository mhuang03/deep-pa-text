import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator } from '../../../src/llm/generator.js';
import { SYSTEM_PROMPT, REVIVE_SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from '../../../src/llm/prompts.js';

import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});
const buckets = { replies: [{ you: 'r', them: 'q' }], similar: ['s1', 's2'], gifs: ['g'], other: ['o'] };

const setup = ({
  retrieverError = null, chatError = null, recent = [], recentError = null, starterRows = [], starterError = null,
  examples = ['x', 'y'], rate = 0, rateError = null, burst = config.burst,
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
  const rateCalls = [];
  const burstProfile = {
    rateFor: (persona) => {
      rateCalls.push(persona);
      if (rateError) throw rateError;
      return rate;
    },
  };
  const generator = createGenerator({
    chatClient, retriever, userDirectory, botMessageStore, messageStore, burstProfile,
    config: { ...config, burst }, logger,
  });
  return { calls, warnings, recentCalls, starterCalls, generator, rateCalls };
};
const RAW_RESULT = { response: 'raw response', parts: ['raw response'] };
const record = { author: 'bob', content: 'hello', timestamp: 5 };

test('generateReply assembles the prompt and returns the sanitised response', async () => {
  const { calls, generator } = setup();
  assert.deepEqual(await generator.generateReply('alice', record), RAW_RESULT);
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
  assert.deepEqual(await generator.generateRevive('alice'), RAW_RESULT);
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
    burstProfile: { rateFor: () => 0 },
    config,
  });
  return generator;
};

test('sanitises replies and revives', async () => {
  const generator = setupWith('"line one\\nline two"');
  const expected = { response: 'line one\nline two', parts: ['line one\nline two'] };
  assert.deepEqual(await generator.generateReply('alice', record), expected);
  assert.deepEqual(await generator.generateRevive('alice'), expected);
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
  assert.deepEqual(await generator.generateReply('alice', record), RAW_RESULT);
  assert.deepEqual(await generator.generateRevive('alice'), RAW_RESULT);
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
  assert.deepEqual(await generator.generateRevive('alice'), RAW_RESULT);
  assert.match(warnings[0], /db locked/);
  assert.ok(!calls.chat[0].user.includes('start a conversation'));
  assert.ok(calls.chat[0].user.includes('["x","y"]'));
});

const chain = {
  persona: 'alice', botTurns: 2,
  turns: [
    { speaker: 'alice', content: 'first', isPersona: true },
    { speaker: 'bob', content: 'older line', isPersona: false },
    { speaker: 'bob', content: 'why', isPersona: false },
  ],
};

test('a chain reply sends the preamble with the thread as chat turns and no transcript or target', async () => {
  const { calls, generator } = setup({ recent: [{ content: 'recent bot' }] });
  assert.deepEqual(await generator.generateReply('alice', { ...record, content: 'why' }, { chain }), RAW_RESULT);
  assert.equal(calls.chat.length, 1);
  assert.equal(calls.chat[0].system, SYSTEM_PROMPT);
  assert.deepEqual(calls.chat[0].turns, chain.turns);
  const { user } = calls.chat[0];
  assert.match(user, /^The user you are emulating has username "alice"/);
  assert.match(user, /\["recent bot"\]/);
  assert.ok(user.endsWith('Write your next message in the thread.'));
  assert.match(user, /You are in a reply thread\. Your own earlier messages in it appear as assistant turns; other people's messages are prefixed with their username\./);
  assert.doesNotMatch(user, /recent conversation in the channel|has just received this message/);
  const order = ['examples of how the user replied', 'similar in semantic', 'included a GIF', 'other messages', 'recent in the channel', 'reply thread']
    .map((s) => user.indexOf(s)).filter((i) => i >= 0);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a chain reply embeds the previous turns plus the message once', async () => {
  const { calls, generator } = setup();
  await generator.generateReply('alice', { ...record, content: 'why' }, { chain });
  assert.deepEqual(calls.reply[0][2], { queryText: 'first\nolder line\nwhy' });
});

test('a long chain message is queried as itself', async () => {
  const { calls, generator } = setup();
  const long = 'a message that is long enough to stand alone';
  await generator.generateReply('alice', { ...record, content: long }, { chain });
  assert.deepEqual(calls.reply[0][2], { queryText: long });
});

test('a context without a chain keeps the plain request shape', async () => {
  const { calls, generator } = setup();
  await generator.generateReply('alice', record, { transcript: [] });
  assert.deepEqual(Object.keys(calls.chat[0]), ['system', 'user']);
});

test('a response with split markers resolves to its parts, sanitised one by one', async () => {
  const generator = setupWith('"one"\n<split>\n"two"');
  const result = await generator.generateReply('alice', record);
  assert.deepEqual(result, { response: 'one\n<split>\ntwo', parts: ['one', 'two'] });
});

test('a bursty persona gets the burst section before avoid-repeats in each prompt', async () => {
  const { calls, generator } = setup({ rate: 0.5, recent: ['earlier'] });
  await generator.generateReply('alice', record);
  await generator.generateRevive('alice');
  calls.chat.forEach(({ user }) => {
    assert.match(user, /split your response into up to 3 separate messages/);
    assert.ok(user.indexOf('This user often sends') < user.indexOf('recently sent these messages'));
  });
});

test('no burst section below the minimum rate or when bursts are disabled', async () => {
  const quiet = setup({ rate: 0.1 });
  await quiet.generator.generateReply('alice', record);
  assert.doesNotMatch(quiet.calls.chat[0].user, /several short messages/);
  const off = setup({ rate: 0.9, burst: { ...config.burst, enabled: false } });
  await off.generator.generateReply('alice', record);
  assert.doesNotMatch(off.calls.chat[0].user, /several short messages/);
  assert.deepEqual(off.rateCalls, []);
});

test('a failing burst measurement is logged and the prompt omits the section', async () => {
  const { calls, warnings, generator } = setup({ rateError: new Error('db gone') });
  await generator.generateReply('alice', record);
  assert.doesNotMatch(calls.chat[0].user, /several short messages/);
  assert.match(warnings[0], /burst rate/);
});

test('a chain reply gets the burst section too', async () => {
  const { calls, generator } = setup({ rate: 0.5 });
  await generator.generateReply('alice', record, { chain: { turns: [{ speaker: 'bob', content: 'hi', isPersona: false }] } });
  assert.match(calls.chat[0].user, /several short messages/);
});

const sequenced = (completions, postProcessRetries = 1) => {
  let index = 0;
  const calls = [];
  const generator = createGenerator({
    chatClient: {
      complete: async (request) => {
        calls.push(request);
        const next = completions[Math.min(index++, completions.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
    },
    retriever: { retrieveForReply: async () => buckets, retrieveForRevive: async () => [] },
    userDirectory: { nameOf: () => 'Alice Example' },
    botMessageStore: { recent: () => [] },
    messageStore: { randomStarters: () => [] },
    burstProfile: { rateFor: () => 0 },
    config: { ...config, llm: { ...config.llm, postProcessRetries } },
    logger: { warn: () => {} },
  });
  return { generator, calls };
};

test('output that cleans to nothing is retried once and the second answer is used', async () => {
  const { generator, calls } = sequenced(['""', 'a real answer']);
  const result = await generator.generateReply('alice', record);
  assert.equal(result.response, 'a real answer');
  assert.equal(calls.length, 2);
});

test('a revive and a chain-less reply both retry empty output', async () => {
  const { generator, calls } = sequenced(['<split>', 'second try']);
  assert.equal((await generator.generateRevive('alice')).response, 'second try');
  assert.equal(calls.length, 2);
});

test('empty output after the allowed retries throws the empty-response error', async () => {
  const { generator, calls } = sequenced(['""']);
  await assert.rejects(generator.generateReply('alice', record), /LLM returned an empty response/);
  assert.equal(calls.length, 2);
});

test('postProcessRetries 0 never retries and 2 retries twice', async () => {
  const none = sequenced(['""'], 0);
  await assert.rejects(none.generator.generateReply('alice', record), /empty response/);
  assert.equal(none.calls.length, 1);
  const twice = sequenced(['""', '""', 'third time'], 2);
  assert.equal((await twice.generator.generateReply('alice', record)).response, 'third time');
  assert.equal(twice.calls.length, 3);
});

test('an exhausted chat client is not retried again, whatever its message says', async () => {
  const { generator, calls } = sequenced([new Error('LLM returned an empty response')]);
  await assert.rejects(generator.generateReply('alice', record), /empty response/);
  assert.equal(calls.length, 1);
});
