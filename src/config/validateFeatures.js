import { above, atLeast, between, checkRules, integer } from './rules.js';

const MAX_SEARCH_LIMIT = 1000;
const MAX_PAGE_SIZE = 100;
const MIN_CONTEXT_TURNS = 2;

export const assertChain = (chain) => checkRules('chain', chain, {
  decay: between(0, 1, 'both'),
  maxContextTurns: integer(MIN_CONTEXT_TURNS),
});

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
});
