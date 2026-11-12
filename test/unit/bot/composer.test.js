import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposer } from '../../../src/bot/composer.js';
import { loadConfig } from '../../../src/config.js';

const setup = ({ links = [], text = 'hello', generate = null } = {}) => {
  const calls = [];
  const generator = {
    generateReply: async (persona, record, context) => {
      calls.push(['reply', persona, record, context]);
      return generate ?? `reply ${text}`;
    },
    generateRevive: async (persona, context) => {
      calls.push(['revive', persona, context]);
      return generate ?? `revive ${text}`;
    },
  };
  const gifResolver = {
    resolve: async (response) => {
      calls.push(['resolve', response]);
      return { content: `resolved ${response}`, gifLinks: links };
    },
  };
  const config = loadConfig({});
  return { composer: createComposer({ generator, gifResolver, config }), calls, config };
};

test('compose with a target generates a reply, resolves GIFs, then returns the parts', async () => {
  const links = [{ match: '<gif! a>', url: 'https://g.example/a.gif' }];
  const { composer, calls } = setup({ links });
  const target = { id: '1', author: 'alice', content: 'hi there', timestamp: 5, reference: null };
  const context = { transcript: [] };
  const result = await composer.compose({ persona: 'bob', target, context });
  assert.deepEqual(result, { response: 'reply hello', content: 'resolved reply hello', gifLinks: links });
  assert.deepEqual(calls, [['reply', 'bob', target, context], ['resolve', 'reply hello']]);
});

test('compose with a null target generates a revive', async () => {
  const { composer, calls } = setup();
  const context = { transcript: [], quietMs: 5, nowMs: 9 };
  const { response, content } = await composer.compose({ persona: 'carol', target: null, context });
  assert.equal(response, 'revive hello');
  assert.equal(content, 'resolved revive hello');
  assert.deepEqual(calls, [['revive', 'carol', context], ['resolve', 'revive hello']]);
});

test('returns unresolved links untouched for the delivery layer to filter', async () => {
  const links = [{ match: '<gif! a>', url: '' }];
  const { composer } = setup({ links });
  const { gifLinks } = await composer.compose({ persona: 'bob', target: {} });
  assert.deepEqual(gifLinks, links);
});

test('propagates generator errors without resolving GIFs', async () => {
  const calls = [];
  const composer = createComposer({
    generator: { generateReply: async () => { throw new Error('llm down'); } },
    gifResolver: { resolve: async () => calls.push('resolve') },
    config: loadConfig({}),
  });
  await assert.rejects(composer.compose({ persona: 'bob', target: {} }), /llm down/);
  assert.deepEqual(calls, []);
});

test('truncates only the delivered content, not the returned response', async () => {
  const text = 'a'.repeat(2500);
  const composer = createComposer({
    generator: { generateReply: async () => text },
    gifResolver: { resolve: async (response) => ({ content: response, gifLinks: [] }) },
    config: loadConfig({}),
  });
  const { response, content } = await composer.compose({ persona: 'bob', target: {} });
  assert.equal(response, text);
  assert.equal(content.length, loadConfig({}).discord.maxMessageLength);
});

test('truncates after GIF processing', async () => {
  const composer = createComposer({
    generator: { generateReply: async () => `<gif! cat>${'a'.repeat(1995)}` },
    gifResolver: { resolve: async () => ({ content: 'a'.repeat(1995), gifLinks: [] }) },
    config: loadConfig({}),
  });
  const { content } = await composer.compose({ persona: 'bob', target: {} });
  assert.equal(content.length, 1995);
});
