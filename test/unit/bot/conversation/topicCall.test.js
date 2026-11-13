import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopicCall } from '../../../../src/bot/conversation/topicCall.js';
import { CONVERSATION_TOPIC_SYSTEM_PROMPT } from '../../../../src/bot/conversation/conversationPrompts.js';
import { loadConfig } from '../../../../src/config.js';

const NOW = Date.parse('2026-11-12T18:00:00Z');
const CANDIDATES = [
  { label: 'A', summary: 'a', samples: [] },
  { label: 'B', summary: 'b', samples: [] },
];
const INPUT = { now: NOW, context: {}, recent: [], candidates: CANDIDATES, openers: [] };

const setup = ({ answers, conversation = {} }) => {
  const requests = [];
  const warnings = [];
  const queue = [...answers];
  const config = loadConfig({});
  const call = createTopicCall({
    chatClient: {
      complete: async (request) => {
        requests.push(request);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return next;
      },
    },
    config: { ...config, conversation: { ...config.conversation, ...conversation } },
    logger: { warn: (...args) => warnings.push(args) },
  });
  return { call, requests, warnings };
};

const answer = (fields) => JSON.stringify({ choice: 1, topic: 'Camping', premise: 'Plans for a trip.', ...fields });

test('sends the system prompt and the assembled user prompt, and returns the choice as a zero-based index', async () => {
  const { call, requests } = setup({ answers: [answer({ choice: 2 })] });
  assert.deepEqual(await call.choose(INPUT), { choice: 1, topic: 'Camping', premise: 'Plans for a trip.' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].system, CONVERSATION_TOPIC_SYSTEM_PROMPT);
  assert.match(requests[0].user, /^It is Thursday 12:00 PM\.\n\nCandidate topics:\n1\. A: a/);
});

test('prose around the JSON is accepted', async () => {
  const { call } = setup({ answers: [`Sure! Here you go:\n${answer()}\nHope that helps.`] });
  assert.equal((await call.choose(INPUT)).topic, 'Camping');
});

test('topic and premise are cleaned of extra whitespace and cut to the configured lengths', async () => {
  const { call } = setup({
    answers: [answer({ topic: '  a   very\nlong topic indeed ', premise: 'one two three four five' })],
    conversation: { maxTopicChars: 10, maxPremiseChars: 13 },
  });
  assert.deepEqual(await call.choose(INPUT), { choice: 0, topic: 'a very lon', premise: 'one two three' });
});

test('a cut never leaves a trailing space', async () => {
  const { call } = setup({ answers: [answer({ topic: 'ab cd ef' })], conversation: { maxTopicChars: 3 } });
  assert.equal((await call.choose(INPUT)).topic, 'ab');
});

test('an invalid answer is asked for again once by default, and a valid second answer is used', async () => {
  const { call, requests, warnings } = setup({ answers: ['no json here', answer({ topic: 'Second try' })] });
  assert.equal((await call.choose(INPUT)).topic, 'Second try');
  assert.equal(requests.length, 2);
  assert.equal(warnings.length, 1);
});

test('invalid twice gives up with null after exactly planRetries + 1 calls', async () => {
  const { call, requests } = setup({ answers: ['nope'] });
  assert.equal(await call.choose(INPUT), null);
  assert.equal(requests.length, 2);
});

test('planRetries 0 asks once and 3 asks four times', async () => {
  const once = setup({ answers: ['nope'], conversation: { planRetries: 0 } });
  assert.equal(await once.call.choose(INPUT), null);
  assert.equal(once.requests.length, 1);
  const many = setup({ answers: ['nope'], conversation: { planRetries: 3 } });
  assert.equal(await many.call.choose(INPUT), null);
  assert.equal(many.requests.length, 4);
});

test('a throwing call gives up at once without a retry and is logged', async () => {
  const { call, requests, warnings } = setup({ answers: [new Error('llm down')] });
  assert.equal(await call.choose(INPUT), null);
  assert.equal(requests.length, 1);
  assert.match(warnings[0][0], /topic call failed/);
});

test('a choice out of range is invalid', async () => {
  for (const choice of [0, 3, -1, 1.5, '1', null, undefined]) {
    const { call } = setup({ answers: [answer({ choice })], conversation: { planRetries: 0 } });
    assert.equal(await call.choose(INPUT), null, `choice ${choice}`);
  }
});

test('missing, empty or non-string topic and premise are invalid', async () => {
  for (const fields of [{ topic: '' }, { topic: '   ' }, { topic: 5 }, { premise: '' }, { premise: null }, { premise: undefined }]) {
    const { call } = setup({ answers: [answer(fields)], conversation: { planRetries: 0 } });
    assert.equal(await call.choose(INPUT), null, JSON.stringify(fields));
  }
});

test('an answer that is JSON but not an object is invalid', async () => {
  const { call } = setup({ answers: ['[1, 2]'], conversation: { planRetries: 0 } });
  assert.equal(await call.choose(INPUT), null);
});
