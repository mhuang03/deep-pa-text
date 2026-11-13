import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConversation } from '../../../src/container/conversation.js';
import { buildAll } from '../../support/containerParts.js';

test('buildConversation returns the policy, planner and runner', () => {
  const all = buildAll();
  const conversation = buildConversation({ ...all, parts: all });
  assert.deepEqual(Object.keys(conversation).sort(), ['conversationPlanner', 'conversationPolicy', 'conversationRunner']);
  assert.deepEqual(Object.keys(conversation.conversationPolicy), ['decide']);
  assert.deepEqual(Object.keys(conversation.conversationPlanner), ['plan']);
  assert.deepEqual(Object.keys(conversation.conversationRunner), ['run']);
  all.storage.db.close();
});

test('the policy reads the container bot message store: a stored conversation turn is too soon', () => {
  const base = buildAll({ CONVERSATIONS: 'true' });
  const clock = { ...base.clock, now: () => 5 * 86400000 };
  const { conversationPolicy } = buildConversation({ ...base, clock, parts: base });
  base.storage.botMessageStore.insert({
    id: 'k1', persona: 'bob', content: 'x', timestamp: 4 * 86400000 + 1, trigger: 'conversation',
    conversationId: 'c1', turnIndex: 0,
  });
  assert.deepEqual(conversationPolicy.decide(), { start: false, reason: 'too-soon' });
  base.storage.db.close();
});

test('the planner shares the container conversation store', async () => {
  const all = buildAll();
  const { conversationPlanner } = buildConversation({ ...all, parts: all });
  const result = await conversationPlanner.plan({ channel: {} });
  assert.deepEqual(result, { failed: 'no-topics' });
  all.storage.db.close();
});
