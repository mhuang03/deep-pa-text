import { createConfigError } from './errors.js';
import { above, atLeast, between, checkRules, integer } from './rules.js';

const MAX_PAGE_SIZE = 1000;
const MIN_CLUSTERS = 2;
const MIN_CLUSTER_SIZE = 2;
const MIN_AUTHORS = 2;
const MIN_REPRESENTATIVES = 2;
const MIN_NEIGHBOURHOOD = 2;

export const assertTopics = (topics) => {
  checkRules('topics', topics, {
    maxMessages: integer(1),
    recentWindowMs: above(0),
    recentShare: between(0, 1),
    sampleOverFetch: integer(1),
    minWords: integer(1),
    minDistinctWords: integer(1),
    minChars: integer(1),
    maxPhraseRepeats: integer(1),
    clusterDivisor: above(0),
    minClusters: integer(MIN_CLUSTERS),
    iterations: integer(1),
    minClusterSize: integer(MIN_CLUSTER_SIZE),
    minAuthors: integer(MIN_AUTHORS),
    minMedianChars: atLeast(0),
    maxAuthorShare: between(0, 1),
    maxPrefixShare: between(0, 1),
    maxLabelled: integer(1),
    representatives: integer(MIN_REPRESENTATIVES),
    embeddingPageSize: integer(1, MAX_PAGE_SIZE),
    maxLabelChars: integer(1),
    maxSummaryChars: integer(1),
    minTopics: integer(1),
    maxConsecutiveFailures: integer(1),
    recencyHalfLifeMs: above(0),
    recencyFloor: between(0, 1),
    maxAgeMs: above(0),
    conversationSamples: integer(1),
    fallbackSeeds: integer(1),
    neighbourhoodSize: integer(MIN_NEIGHBOURHOOD),
    minNeighbours: integer(MIN_NEIGHBOURHOOD),
  });
  if (!(Number.isInteger(topics.maxClusters) && topics.maxClusters >= topics.minClusters)) {
    throw createConfigError(`topics.maxClusters must be an integer of at least topics.minClusters (${topics.minClusters})`);
  }
  return topics;
};
