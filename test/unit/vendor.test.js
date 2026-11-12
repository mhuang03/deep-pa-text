import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVendor } from '../../src/vendor.js';

test('returns the six third-party members', () => {
  const vendor = createVendor();
  assert.deepEqual(
    Object.keys(vendor).sort(),
    ['ChromaClient', 'Client', 'GiphyFetch', 'OpenAI', 'OpenAIEmbeddingFunction', 'fetch'],
  );
  ['ChromaClient', 'Client', 'GiphyFetch', 'OpenAI', 'OpenAIEmbeddingFunction', 'fetch']
    .forEach((name) => assert.equal(typeof vendor[name], 'function', name));
});

test('fetch resolves globalThis.fetch at call time', async (t) => {
  const vendor = createVendor();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => (calls.push(args), 'mocked'));
  assert.equal(await vendor.fetch('https://example.test', { method: 'GET' }), 'mocked');
  assert.deepEqual(calls, [['https://example.test', { method: 'GET' }]]);
});
