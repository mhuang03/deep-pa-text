import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, isConfigError, createConfigError } from '../../../src/config.js';
import { assertRequired, buildGifKeyWarning } from '../../../src/config/requirements.js';

const config = loadConfig({});
const MISSING = 'Missing required environment variables: ';

const messageOf = (env, purpose) => {
  try {
    assertRequired(config, env, purpose);
  } catch (error) {
    assert.ok(isConfigError(error), 'is a config error');
    return error.message;
  }
  return null;
};

test('bot requires the Discord token, the DeepSeek key and the embedding key, all listed at once', () => {
  assert.equal(messageOf({}, 'bot'),
    `${MISSING}DISCORD_BOT_TOKEN, DEEPSEEK_API_KEY, OPENAI_API_KEY. Set them in .env or the environment.`);
  assert.equal(messageOf({ DISCORD_BOT_TOKEN: 't', DEEPSEEK_API_KEY: 'd', OPENAI_API_KEY: 'o' }, 'bot'), null);
});

test('an OpenAI key without a DeepSeek key names DEEPSEEK_API_KEY only', () => {
  assert.match(messageOf({ DISCORD_BOT_TOKEN: 't', OPENAI_API_KEY: 'o' }, 'bot'), /: DEEPSEEK_API_KEY\. Set/);
});

test('empty and whitespace-only values count as missing', () => {
  const env = { DISCORD_BOT_TOKEN: '   ', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: 'o' };
  assert.match(messageOf(env, 'bot'), /: DISCORD_BOT_TOKEN, DEEPSEEK_API_KEY\. Set/);
});

test('backfill and reimport need no DeepSeek key', () => {
  ['backfill', 'reimport'].forEach((purpose) => {
    assert.equal(messageOf({ DISCORD_BOT_TOKEN: 't', OPENAI_API_KEY: 'o' }, purpose), null);
    assert.match(messageOf({}, purpose), /: DISCORD_BOT_TOKEN, OPENAI_API_KEY\. Set/);
  });
});

test('the embedding variable name comes from the config', () => {
  const custom = { ...config, embedding: { ...config.embedding, apiKeyEnvVar: 'EMBED_KEY' } };
  assert.throws(() => assertRequired(custom, { DISCORD_BOT_TOKEN: 't' }, 'backfill'), /EMBED_KEY/);
});

test('register needs the token and the client id and nothing else', () => {
  assert.equal(messageOf({ DISCORD_BOT_TOKEN: 't', DISCORD_CLIENT_ID: 'c' }, 'register'), null);
  assert.match(messageOf({ DISCORD_BOT_TOKEN: 't' }, 'register'), /: DISCORD_CLIENT_ID\. Set/);
});

test('gif-smoke needs at least one GIF key', () => {
  assert.match(messageOf({}, 'gif-smoke'), /at least one of KLIPY_API_KEY, GIPHY_API_KEY, HUMOR_API_KEY/);
  assert.match(messageOf({ GIPHY_API_KEY: ' ' }, 'gif-smoke'), /at least one of/);
  assert.equal(messageOf({ HUMOR_API_KEY: 'h' }, 'gif-smoke'), null);
});

test('inspect needs nothing', () => {
  assert.equal(messageOf({}, 'inspect'), null);
});

test('an unknown purpose is a plain bug, not a config error', () => {
  assert.throws(() => assertRequired(config, {}, 'nope'), (e) => e instanceof Error && !isConfigError(e));
});

test('createConfigError makes an Error marked as a config error', () => {
  const error = createConfigError('bad');
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'bad');
  assert.equal(isConfigError(error), true);
});

test('the GIF warning names the variables only when no key is set', () => {
  const warning = buildGifKeyWarning(loadConfig({}));
  assert.match(warning, /KLIPY_API_KEY, GIPHY_API_KEY, HUMOR_API_KEY/);
  assert.equal(buildGifKeyWarning(loadConfig({ GIPHY_API_KEY: 'g' })), null);
});

test('topics needs the DeepSeek key and the embedding key', () => {
  assert.match(messageOf({}, 'topics'), /: DEEPSEEK_API_KEY, OPENAI_API_KEY\. Set/);
  assert.equal(messageOf({ DEEPSEEK_API_KEY: 'd', OPENAI_API_KEY: 'o' }, 'topics'), null);
});

test('topics-dry-run needs only the embedding key and topics-bank needs nothing', () => {
  assert.match(messageOf({}, 'topics-dry-run'), /: OPENAI_API_KEY\. Set/);
  assert.equal(messageOf({ OPENAI_API_KEY: 'o' }, 'topics-dry-run'), null);
  assert.equal(messageOf({}, 'topics-bank'), null);
});
