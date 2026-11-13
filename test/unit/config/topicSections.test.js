import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopics } from '../../../src/config/topicSections.js';
import { DEFAULTS, loadConfig } from '../../../src/config.js';

test('buildTopics holds the specified defaults, including the amendments', () => {
  const topics = buildTopics();
  assert.equal(topics.maxMessages, 30000);
  assert.equal(topics.recentWindowMs, 365 * 86400000);
  assert.equal(topics.recencyHalfLifeMs, 180 * 86400000);
  assert.equal(topics.maxAgeMs, 90 * 86400000);
  assert.equal(topics.maxLabelled, 80);
  assert.equal(topics.minTopics, 3);
  assert.equal(topics.maxConsecutiveFailures, 3);
  assert.equal(topics.minDistinctWords, 4);
  assert.equal(topics.maxAuthorShare, 0.6);
  assert.equal(topics.maxPrefixShare, 0.3);
  assert.equal(topics.sampleOverFetch, 2);
});

test('the topics section is part of the loaded configuration and has no environment override', () => {
  assert.deepEqual(DEFAULTS.topics, buildTopics());
  assert.deepEqual(loadConfig({ TOPICS_MAX_MESSAGES: '5' }).topics, buildTopics());
});
