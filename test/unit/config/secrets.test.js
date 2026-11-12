import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, secretsOf } from '../../../src/config.js';

test('the embedding key is read from the variable named by apiKeyEnvVar', () => {
  const config = loadConfig({ OPENAI_API_KEY: 'embedding-key-1234' });
  assert.equal(config.embedding.apiKey, 'embedding-key-1234');
  assert.equal(config.embedding.apiKeyEnvVar, 'OPENAI_API_KEY');
});

test('secretsOf lists the token, LLM, embedding and GIF keys, longest first, without short values', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'token-12345678', DEEPSEEK_API_KEY: 'llm-key-123456789', OPENAI_API_KEY: 'emb-key-1',
    KLIPY_API_KEY: 'short', GIPHY_API_KEY: 'giphy-key-12', HUMOR_API_KEY: 'humor-key',
  });
  assert.deepEqual(secretsOf(config), [
    'llm-key-123456789', 'token-12345678', 'giphy-key-12', 'emb-key-1', 'humor-key',
  ]);
});

test('secretsOf of an empty environment is empty and drops duplicates', () => {
  assert.deepEqual(secretsOf(loadConfig({})), []);
  assert.deepEqual(secretsOf(loadConfig({ DEEPSEEK_API_KEY: 'same-value-1', OPENAI_API_KEY: 'same-value-1' })), ['same-value-1']);
});
