import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConversation } from '../../../src/config/conversationSections.js';
import { DEFAULTS, loadConfig, isConfigError } from '../../../src/config.js';

test('buildConversation holds the specified defaults', () => {
  assert.deepEqual(buildConversation({}), {
    enabled: true, chance: 0.1, minIntervalMs: 24 * 3600000, minPersonas: 2, maxPersonas: 5, minMessages: 3,
    maxMessages: 6, minDelayMs: 5000, maxDelayMs: 30000, topicCandidates: 5, openerSamples: 6, avoidRecentTopics: 10,
    planRetries: 1, personaHits: 60, maxTopicChars: 80, maxPremiseChars: 300, arrangeAttempts: 50,
  });
});

test('the conversation section is part of the loaded configuration', () => {
  assert.deepEqual(DEFAULTS.conversation, buildConversation({}));
});

test('CONVERSATIONS switches the feature off and on and is a strict boolean', () => {
  assert.equal(loadConfig({ CONVERSATIONS: 'false' }).conversation.enabled, false);
  assert.equal(loadConfig({ CONVERSATIONS: 'TRUE' }).conversation.enabled, true);
  assert.equal(loadConfig({ CONVERSATIONS: '  ' }).conversation.enabled, true);
  assert.throws(() => loadConfig({ CONVERSATIONS: 'yes' }), (e) => isConfigError(e) && /CONVERSATIONS must be "true" or "false"/.test(e.message));
});

test('no other tunable has an environment override', () => {
  assert.deepEqual({ ...loadConfig({ CONVERSATION_CHANCE: '1' }).conversation }, { ...buildConversation({}) });
});
