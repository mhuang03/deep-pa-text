import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviveGenerator } from '../../../src/llm/reviveGenerator.js';
import { REVIVE_SYSTEM_PROMPT } from '../../../src/llm/prompts.js';
import { loadConfig } from '../../../src/config.js';

const setup = ({ examples = ['one', 'two'], starters = ['two'] } = {}) => {
  const calls = [];
  const generator = createReviveGenerator({
    complete: async (...args) => { calls.push(args); return { response: 'revived' }; },
    retriever: { retrieveForRevive: async () => examples },
    userDirectory: { nameOf: (u) => `Name of ${u}` },
    inputs: { recentBotMessages: () => [], burstRate: () => 0, starters: () => starters },
    config: loadConfig({}),
  });
  return { generator, calls };
};

test('completes with the revive system prompt', async () => {
  const { generator, calls } = setup();
  assert.deepEqual(await generator.generateRevive('bob', { nowMs: 0 }), { response: 'revived' });
  assert.equal(calls[0][1], REVIVE_SYSTEM_PROMPT);
});

test('examples that duplicate a starter (up to spelling) are left out of the prompt', async () => {
  const { generator, calls } = setup({ examples: ['alpha example', 'Beta   example'], starters: ['beta example'] });
  await generator.generateRevive('bob', { nowMs: 0 });
  const prompt = calls[0][0];
  assert.match(prompt, /alpha example/);
  assert.equal((prompt.match(/beta\s+example/gi) ?? []).length, 1);
});

test('works without a context argument', async () => {
  const { generator } = setup();
  await assert.doesNotReject(generator.generateRevive('bob'));
});
