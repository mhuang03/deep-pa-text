import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTopics } from '../../../src/config/validateTopics.js';
import { DEFAULTS, isConfigError, assertTopics as exported } from '../../../src/config.js';

const base = DEFAULTS.topics;
const bad = (key, value, pattern) => assert.throws(
  () => assertTopics({ ...base, [key]: value }),
  (error) => isConfigError(error) && pattern.test(error.message),
  `${key}=${value}`,
);

test('the defaults pass their own validator', () => {
  assert.equal(assertTopics(base), base);
});

test('each bounded key rejects a value outside its range and accepts the boundary', () => {
  const cases = [
    ['maxMessages', 0, 1], ['recentShare', 1.1, 1], ['recentShare', -0.1, 0], ['minWords', 0, 1], ['minChars', 0, 1],
    ['maxPhraseRepeats', 0, 1], ['clusterDivisor', 0, 0.5], ['minClusters', 1, 2], ['iterations', 0, 1],
    ['minClusterSize', 1, 2], ['minAuthors', 1, 2], ['minMedianChars', -1, 0], ['maxLabelled', 0, 1],
    ['representatives', 1, 2], ['embeddingPageSize', 0, 1], ['embeddingPageSize', 1001, 1000], ['recencyHalfLifeMs', 0, 1],
    ['recencyFloor', 1.5, 1], ['maxAgeMs', 0, 1], ['conversationSamples', 0, 1], ['fallbackSeeds', 0, 1],
    ['neighbourhoodSize', 1, 2], ['minNeighbours', 1, 2], ['minTopics', 0, 1], ['maxConsecutiveFailures', 0, 1],
    ['minDistinctWords', 0, 1], ['maxAuthorShare', 1.1, 1], ['maxPrefixShare', 2, 0], ['sampleOverFetch', 0, 1],
    ['maxLabelChars', 0, 1], ['maxSummaryChars', 0, 1], ['recentWindowMs', 0, 1],
  ];
  cases.forEach(([key, invalid, valid]) => {
    bad(key, invalid, new RegExp(`topics\\.${key}`));
    assert.doesNotThrow(() => assertTopics({ ...base, [key]: valid }), `${key}=${valid}`);
  });
});

test('integers must be integers', () => {
  bad('maxMessages', 1.5, /topics\.maxMessages/);
  bad('minTopics', 2.5, /topics\.minTopics/);
});

test('maxClusters must be an integer of at least minClusters', () => {
  bad('maxClusters', 4, /topics\.maxClusters/);
  bad('maxClusters', 5.5, /topics\.maxClusters/);
  assert.doesNotThrow(() => assertTopics({ ...base, maxClusters: 5 }));
});

test('the validator is exported from the configuration module', () => {
  assert.equal(exported, assertTopics);
});
