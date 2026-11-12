import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryReader } from '../../../src/backfill/historyReader.js';

const message = (n) => ({
  id: `m${String(n).padStart(4, '0')}`, content: `c${n}`, createdTimestamp: n,
  author: { id: 'u', username: 'alice', bot: false }, embeds: [],
});

// Serves a newest-first history through fetchBefore like channelHistory does (oldest first per page).
const setup = ({ total = 0, failures = [], hang = 0, pageSize = 100, pageRetries = 3 } = {}) => {
  const all = Array.from({ length: total }, (_, i) => message(i + 1));
  const calls = [];
  const sleeps = [];
  const timers = [];
  let pending = [...failures];
  let hangsLeft = hang;
  const channelHistory = {
    fetchBefore: async (channel, args) => {
      calls.push(args);
      if (hangsLeft > 0) {
        hangsLeft -= 1;
        return new Promise(() => {});
      }
      if (pending.length > 0) throw pending.shift();
      const end = args.before ? all.findIndex((m) => m.id === args.before) : all.length;
      return all.slice(Math.max(0, end - args.limit), end);
    },
  };
  const clock = {
    sleep: async (ms) => sleeps.push(ms),
    setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimeout: () => {},
  };
  const infos = [];
  const logger = { info: (...a) => infos.push(a), warn: () => {} };
  const config = { backfill: { pageSize, pageRetries, retryDelayMs: 2000, pageTimeoutMs: 30000 } };
  const reader = createHistoryReader({ channelHistory, config, clock, logger });
  return { reader, calls, sleeps, timers, infos };
};

test('an empty channel yields nothing after one request', async () => {
  const { reader, calls } = setup();
  assert.deepEqual(await reader.readAll({}, {}), []);
  assert.equal(calls.length, 1);
});

test('250 messages take pages of 100, 100, 50 and an empty fourth, returned oldest first', async () => {
  const { reader, calls } = setup({ total: 250 });
  const messages = await reader.readAll({}, {});
  assert.equal(messages.length, 250);
  assert.deepEqual(messages.map((m) => m.createdTimestamp), Array.from({ length: 250 }, (_, i) => i + 1));
  assert.deepEqual(calls.map((c) => c.limit), [100, 100, 100, 100]);
  assert.equal(calls[1].before, 'm0151');
  assert.equal(calls[0].throwOnError, true);
  assert.equal(calls[0].cache, false);
});

test('limit counts every fetched message and shrinks the last page', async () => {
  const { reader, calls } = setup({ total: 250 });
  const messages = await reader.readAll({}, { limit: 120 });
  assert.equal(messages.length, 120);
  assert.deepEqual(calls.map((c) => c.limit), [100, 20]);
  assert.equal(messages[0].createdTimestamp, 131);
  assert.equal(messages.at(-1).createdTimestamp, 250);
});

test('before starts the first page at that id', async () => {
  const { reader, calls } = setup({ total: 50 });
  const messages = await reader.readAll({}, { before: 'm0011' });
  assert.equal(calls[0].before, 'm0011');
  assert.equal(messages.length, 10);
});

test('converts each page to history messages', async () => {
  const { reader } = setup({ total: 1 });
  const [first] = await reader.readAll({}, {});
  assert.equal(first.webhookId, null);
  assert.deepEqual(first.author, { id: 'u', username: 'alice', bot: false });
});

test('a page that fails twice then succeeds is retried after two delays', async () => {
  const { reader, sleeps } = setup({ total: 5, failures: [new Error('a'), new Error('b')] });
  assert.equal((await reader.readAll({}, {})).length, 5);
  assert.deepEqual(sleeps, [2000, 2000]);
});

test('a page that keeps failing rejects after pageRetries retries', async () => {
  const errors = [1, 2, 3, 4].map((n) => new Error(`fail ${n}`));
  const { reader, sleeps, calls } = setup({ total: 5, failures: errors });
  await assert.rejects(reader.readAll({}, {}), /fail 4/);
  assert.equal(sleeps.length, 3);
  assert.equal(calls.length, 4);
});

test('a hanging page request times out and is retried', async () => {
  const { reader, timers } = setup({ total: 3, hang: 1 });
  const read = reader.readAll({}, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[0].ms, 30000);
  timers[0].fn();
  assert.equal((await read).length, 3);
});

test('logs progress after each page', async () => {
  const { reader, infos } = setup({ total: 150 });
  await reader.readAll({}, {});
  assert.equal(infos.length, 2);
});
