import { above, atLeast, checkRules, integer } from './rules.js';

const MAX_SEARCH_LIMIT = 1000;
const MAX_PAGE_SIZE = 100;
const MIN_CONTEXT_TURNS = 2;
const MIN_FUZZY_LENGTH = 2;

export const assertChain = (chain) => checkRules('chain', chain, {
  maxContextTurns: integer(MIN_CONTEXT_TURNS),
});

export const assertMention = (mention) => {
  checkRules('mention', mention, { fuzzyMinLength: integer(MIN_FUZZY_LENGTH) });
  return checkRules('mention', mention, { fuzzyWideMinLength: integer(mention.fuzzyMinLength) });
};

export const assertBurst = (burst) => checkRules('burst', burst, {
  maxMessages: integer(1),
});

export const assertProfiles = (profiles) => checkRules('profiles', profiles, {
  refreshIntervalMs: integer(0),
  minCheckIntervalMs: atLeast(0),
  lookupTimeoutMs: above(0),
  searchLimit: integer(1, MAX_SEARCH_LIMIT),
});

export const assertBackfill = (backfill) => checkRules('backfill', backfill, {
  pageSize: integer(1, MAX_PAGE_SIZE),
  batchSize: integer(1),
  pageRetries: integer(0),
  retryDelayMs: atLeast(0),
  pageTimeoutMs: above(0),
  comparisonPageSize: integer(1),
});

export const assertLifecycle = (lifecycle) => checkRules('lifecycle', lifecycle, {
  graceMs: atLeast(0),
  pollMs: above(0),
});

export const assertVector = (vector) => checkRules('vector', vector, {
  repairIntervalMs: above(0),
  repairWindowMs: above(0),
});

export const assertCatchUp = (catchUp) => checkRules('catchUp', catchUp, {
  maxMessages: integer(1),
});
