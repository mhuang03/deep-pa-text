import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBuilder } from '../../../src/context/contextBuilder.js';

const HOUR = 3600000;
const T = Date.UTC(2026, 10, 12, 18, 0);
const config = {
  context: { transcriptLimit: 7, maxEntryChars: 10, maxAgeMs: 6 * HOUR },
  revive: { transcriptLimit: 4 },
};
const msg = (id, content, timestamp, bot = false) => ({
  id, content, createdTimestamp: timestamp, author: { username: 'alice', bot },
});

const setup = (messages) => {
  const calls = [];
  const channelHistory = {
    fetchBefore: async (channel, args) => {
      calls.push([channel, args]);
      return messages;
    },
  };
  const botMessageResolver = { resolve: (m) => (m.id === 'bot' ? { persona: 'bob', content: 'stored' } : null) };
  const messageFilter = { transform: (text) => text };
  const builder = createContextBuilder({ channelHistory, botMessageResolver, messageFilter, config });
  return { builder, calls };
};

test('fetches the configured limit before the target and builds the transcript', async () => {
  const channel = { id: 'c' };
  const { builder, calls } = setup([msg('1', 'hello', T - 1000), msg('bot', 'raw', T - 500, true)]);
  const { transcript } = await builder.forReply({ channel, target: { id: 't', timestamp: T } });
  assert.deepEqual(calls, [[channel, { before: 't', limit: 7 }]]);
  assert.deepEqual(transcript.map((e) => [e.speaker, e.content]), [['alice', 'hello'], ['bob', 'stored']]);
});

test('drops messages older than maxAgeMs before the target and truncates long entries', async () => {
  const { builder } = setup([
    msg('old', 'ancient', T - 6 * HOUR - 1), msg('edge', 'edge', T - 6 * HOUR), msg('long', 'x'.repeat(11), T - 1),
  ]);
  const { transcript } = await builder.forReply({ channel: {}, target: { id: 't', timestamp: T } });
  assert.deepEqual(transcript.map((e) => e.content), ['edge', `${'x'.repeat(10)}…`]);
});

test('a missing channel yields an empty transcript without fetching', async () => {
  const { builder, calls } = setup([msg('1', 'hello', T)]);
  assert.deepEqual(await builder.forReply({ channel: undefined, target: { id: 't', timestamp: T } }), { transcript: [] });
  assert.deepEqual(calls, []);
});

test('forRevive fetches the revive limit with no before and measures quiet from the newest message', async () => {
  const channel = { id: 'c' };
  const { builder, calls } = setup([msg('1', 'hello', T - 10 * HOUR), msg('bot', 'raw', T - 2 * HOUR, true)]);
  const result = await builder.forRevive({ channel, nowMs: T });
  assert.deepEqual(calls, [[channel, { limit: 4 }]]);
  assert.deepEqual(result.transcript.map((e) => [e.speaker, e.content]), [['alice', 'hello'], ['bob', 'stored']]);
  assert.equal(result.quietMs, 2 * HOUR);
  assert.equal(result.nowMs, T);
});

test('forRevive applies no age cut-off', async () => {
  const { builder } = setup([msg('old', 'ancient', T - 100 * HOUR)]);
  const { transcript, quietMs } = await builder.forRevive({ channel: {}, nowMs: T });
  assert.deepEqual(transcript.map((e) => e.content), ['ancient']);
  assert.equal(quietMs, 100 * HOUR);
});

test('forRevive measures quiet from a newest message that yields no entry', async () => {
  const { builder } = setup([msg('1', 'hello', T - 3 * HOUR), msg('2', '   ', T - HOUR)]);
  const { transcript, quietMs } = await builder.forRevive({ channel: {}, nowMs: T });
  assert.equal(transcript.length, 1);
  assert.equal(quietMs, HOUR);
});

test('forRevive with nothing fetched has an empty transcript and null quiet', async () => {
  const { builder } = setup([]);
  assert.deepEqual(await builder.forRevive({ channel: {}, nowMs: T }), { transcript: [], quietMs: null, nowMs: T });
});
