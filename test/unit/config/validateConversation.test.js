import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConversation } from '../../../src/config/validateConversation.js';
import { DEFAULTS, isConfigError, assertConversation as exported } from '../../../src/config.js';

const base = DEFAULTS.conversation;
const bad = (overrides, pattern) => assert.throws(
  () => assertConversation({ ...base, ...overrides }),
  (error) => isConfigError(error) && pattern.test(error.message),
  JSON.stringify(overrides),
);
const good = (overrides) => assert.doesNotThrow(() => assertConversation({ ...base, ...overrides }), JSON.stringify(overrides));

test('the defaults pass their own validator and the validator is exported from config', () => {
  assert.equal(assertConversation(base), base);
  assert.equal(exported, assertConversation);
});

test('each bounded key rejects a value outside its range and accepts the boundary', () => {
  const cases = [
    ['chance', 1.1, 1], ['chance', -0.1, 0], ['minIntervalMs', -1, 0], ['minPersonas', 1, 2], ['minMessages', 0, 1],
    ['minDelayMs', -1, 0], ['topicCandidates', 0, 1], ['openerSamples', -1, 0], ['avoidRecentTopics', -1, 0],
    ['planRetries', -1, 0], ['personaHits', 0, 1], ['maxTopicChars', 0, 1], ['maxPremiseChars', 0, 1],
    ['arrangeAttempts', 0, 1],
  ];
  cases.forEach(([key, invalid, valid]) => {
    bad({ [key]: invalid }, new RegExp(`conversation\\.${key}`));
    good({ [key]: valid });
  });
});

test('counts and millisecond values must be integers', () => {
  ['minIntervalMs', 'minDelayMs', 'maxDelayMs', 'minPersonas', 'maxPersonas', 'minMessages', 'maxMessages',
    'topicCandidates', 'openerSamples', 'avoidRecentTopics', 'planRetries', 'personaHits', 'maxTopicChars',
    'maxPremiseChars', 'arrangeAttempts'].forEach((key) => bad({ [key]: base[key] + 0.5 }, new RegExp(`conversation\\.${key}`)));
});

test('the maximums must allow their minimums', () => {
  bad({ maxPersonas: 1 }, /conversation\.maxPersonas/);
  good({ minPersonas: 3, maxPersonas: 3 });
  bad({ minMessages: 7, maxMessages: 6 }, /conversation\.maxMessages/);
  good({ minMessages: 6, maxMessages: 6 });
  bad({ minDelayMs: 100, maxDelayMs: 99 }, /conversation\.maxDelayMs/);
  good({ minDelayMs: 100, maxDelayMs: 100 });
});

test('every persona must be able to speak: maxMessages is at least maxPersonas', () => {
  bad({ maxPersonas: 7, maxMessages: 6 }, /conversation\.maxMessages/);
  good({ maxPersonas: 6, maxMessages: 6 });
});
