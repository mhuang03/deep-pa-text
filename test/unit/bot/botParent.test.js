import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotParentFinder } from '../../../src/bot/botParent.js';

const setup = ({ stored = null, raw = null, resolved = null, fetchError = null } = {}) => {
  const warnings = [];
  const finder = createBotParentFinder({
    botMessageStore: { getById: () => stored },
    messageStore: { getRaw: () => raw },
    botMessageResolver: { resolve: () => resolved },
    logger: { warn: (...a) => warnings.push(a) },
  });
  const message = {
    fetches: 0,
    fetchReference: async () => {
      message.fetches += 1;
      if (fetchError) throw fetchError;
      return { id: 'p' };
    },
  };
  return { finder, message, warnings };
};

test('no reference means no parent and no fetch', async () => {
  const { finder, message } = setup({ stored: { id: 'x' } });
  assert.equal(await finder.find(message, { reference: null }), null);
  assert.equal(message.fetches, 0);
});

test('a stored bot message is the parent', async () => {
  const stored = { id: 'p', persona: 'bob', content: 'hi', reference: null };
  const { finder, message } = setup({ stored });
  assert.deepEqual(await finder.find(message, { reference: 'p' }), stored);
  assert.equal(message.fetches, 0);
});

test('a known human message is not a bot parent and is not fetched', async () => {
  const { finder, message } = setup({ raw: { id: 'p' } });
  assert.equal(await finder.find(message, { reference: 'p' }), null);
  assert.equal(message.fetches, 0);
});

test('an unknown message is fetched and resolved into a fallback parent', async () => {
  const { finder, message } = setup({ resolved: { persona: 'bob', content: 'old' } });
  assert.deepEqual(await finder.find(message, { reference: 'p' }), {
    id: 'p', persona: 'bob', content: 'old', reference: null, fallback: true,
  });
  assert.equal(message.fetches, 1);
});

test('an unknown message that does not resolve is not a bot parent', async () => {
  const { finder, message } = setup();
  assert.equal(await finder.find(message, { reference: 'p' }), null);
});

test('a failed fetch is logged and treated as no parent', async () => {
  const { finder, message, warnings } = setup({ fetchError: new Error('gone') });
  assert.equal(await finder.find(message, { reference: 'p' }), null);
  assert.equal(warnings.length, 1);
});
