import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelHistory, MAX_FETCH_LIMIT } from '../../../src/discord/channelHistory.js';

const setup = (fetch) => {
  const warnings = [];
  const channel = { messages: { fetch } };
  const history = createChannelHistory({ logger: { warn: (...args) => warnings.push(args) } });
  return { history, channel, warnings };
};

test('returns the fetched messages oldest first without re-sorting', async () => {
  const page = new Map([['c', { id: 'c' }], ['a', { id: 'a' }], ['b', { id: 'b' }]]);
  const { history, channel } = setup(async () => page);
  const result = await history.fetchBefore(channel, { before: 'x', limit: 3 });
  assert.deepEqual(result.map((m) => m.id), ['b', 'a', 'c']);
});

test('passes before and limit to the channel', async () => {
  const calls = [];
  const { history, channel } = setup(async (args) => {
    calls.push(args);
    return new Map();
  });
  assert.deepEqual(await history.fetchBefore(channel, { before: 'x', limit: 20 }), []);
  assert.deepEqual(calls, [{ limit: 20, before: 'x' }]);
});

test('caps the limit at the Discord page size', async () => {
  const calls = [];
  const { history, channel } = setup(async (args) => {
    calls.push(args);
    return new Map();
  });
  await history.fetchBefore(channel, { before: 'x', limit: 500 });
  await history.fetchBefore(channel, { before: 'x', limit: 100 });
  assert.deepEqual(calls.map((c) => c.limit), [MAX_FETCH_LIMIT, MAX_FETCH_LIMIT]);
  assert.equal(MAX_FETCH_LIMIT, 100);
});

test('a failed fetch logs a warning and yields no messages', async () => {
  const boom = new Error('missing access');
  const { history, channel, warnings } = setup(async () => {
    throw boom;
  });
  assert.deepEqual(await history.fetchBefore(channel, { before: 'x', limit: 5 }), []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].at(-1), boom);
});
