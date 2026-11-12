import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompleter } from '../../../src/llm/generatorComplete.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});

const setup = (responses) => {
  const requests = [];
  const warnings = [];
  const queue = [...responses];
  const { complete } = createCompleter({
    chatClient: { complete: async (request) => { requests.push(request); const next = queue.shift(); if (next instanceof Error) throw next; return next; } },
    config,
    logger: { warn: (m) => warnings.push(m) },
  });
  return { complete, requests, warnings };
};

test('sends the system prompt and user text and returns the cleaned response', async () => {
  const { complete, requests } = setup(['  hello there  ']);
  const result = await complete('user text', 'system text');
  assert.deepEqual(requests, [{ system: 'system text', user: 'user text' }]);
  assert.equal(result.response, 'hello there');
});

test('passes chat turns when given', async () => {
  const { complete, requests } = setup(['ok']);
  await complete('u', 's', [{ role: 'user', content: 'x' }]);
  assert.deepEqual(requests[0].turns, [{ role: 'user', content: 'x' }]);
});

test('requests another completion when the output cleans to nothing', async () => {
  const { complete, requests, warnings } = setup(['   ', 'second try']);
  const result = await complete('u', 's');
  assert.equal(result.response, 'second try');
  assert.equal(requests.length, 2);
  assert.equal(warnings.length, 1);
});

test('gives up with the empty-output error after postProcessRetries retries', async () => {
  const { complete, requests } = setup(['', '', '']);
  await assert.rejects(complete('u', 's'), (error) => error.isEmptyOutput === true && /empty response/.test(error.message));
  assert.equal(requests.length, config.llm.postProcessRetries + 1);
});

test('does not retry a chat client failure', async () => {
  const { complete, requests } = setup([new Error('network')]);
  await assert.rejects(complete('u', 's'), /network/);
  assert.equal(requests.length, 1);
});
