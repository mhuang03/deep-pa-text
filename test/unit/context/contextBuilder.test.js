import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBuilder } from '../../../src/context/contextBuilder.js';

const HOUR = 3600000;
const T = Date.UTC(2026, 10, 12, 18, 0);
const config = { context: { transcriptLimit: 7, maxEntryChars: 10, maxAgeMs: 6 * HOUR } };
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
