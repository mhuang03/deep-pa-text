import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextResolver } from '../../../src/bot/responderContext.js';

const setup = ({ failRevive = null, failReply = null } = {}) => {
  const calls = [];
  const logs = [];
  const { contextFor } = createContextResolver({
    contextBuilder: {
      forRevive: async (arg) => { calls.push(['revive', arg]); if (failRevive) throw failRevive; return { quietMs: 5 }; },
      forReply: async (arg) => { calls.push(['reply', arg]); if (failReply) throw failReply; return { transcript: ['x'] }; },
    },
    clock: { now: () => 1234 },
    logger: { warn: (...a) => logs.push(a) },
  });
  return { contextFor, calls, logs };
};

test('a chain request carries its own context and builds nothing', async () => {
  const { contextFor, calls } = setup();
  assert.deepEqual(await contextFor({ chain: { turns: [] }, target: { id: '1' }, channel: {} }), { chain: { turns: [] } });
  assert.deepEqual(calls, []);
});

test('a request without a target builds the revive context at the current time', async () => {
  const { contextFor, calls } = setup();
  assert.deepEqual(await contextFor({ target: null, channel: { id: 'c' } }), { quietMs: 5 });
  assert.deepEqual(calls, [['revive', { channel: { id: 'c' }, nowMs: 1234 }]]);
});

test('a request with a target builds the reply transcript', async () => {
  const { contextFor, calls } = setup();
  assert.deepEqual(await contextFor({ target: { id: '1' }, channel: { id: 'c' } }), { transcript: ['x'] });
  assert.deepEqual(calls, [['reply', { channel: { id: 'c' }, target: { id: '1' } }]]);
});

test('failed contexts degrade to empty ones and log a warning', async () => {
  const revive = setup({ failRevive: new Error('db') });
  assert.deepEqual(await revive.contextFor({ target: null, channel: {} }), {});
  assert.match(revive.logs[0][0], /revive context/);
  const reply = setup({ failReply: new Error('db') });
  assert.deepEqual(await reply.contextFor({ target: { id: '9' }, channel: {} }), { transcript: [] });
  assert.match(reply.logs[0][0], /transcript for 9/);
});
