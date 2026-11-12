import { createConfigError } from './errors.js';
import { above, atLeast, between, checkRules, integer } from './rules.js';

export { checkRules } from './rules.js';

export const assertGifs = (gifs) => checkRules('gifs', gifs, {
  candidates: integer(1),
  timeoutMs: above(0),
});

export const assertLlm = (llm) => checkRules('llm', llm, {
  timeoutMs: above(0),
  maxRetries: integer(0),
  emptyRetries: integer(0),
});

export const assertReply = (reply) => checkRules('reply', reply, {
  probability: between(0, 1),
  minIntervalMs: atLeast(0),
});

export const assertFilter = (filter) => {
  checkRules('filter', filter, { minLength: atLeast(0), maxLength: atLeast(0) });
  if (filter.minLength > filter.maxLength) {
    throw createConfigError('filter.minLength must not be greater than filter.maxLength');
  }
  return filter;
};

export const assertStorage = (storage) => checkRules('storage', storage, {
  busyTimeoutMs: integer(0),
});

export const assertRetrieval = (retrieval) => checkRules('retrieval', retrieval, {
  replyResults: integer(1),
  similarResults: integer(1),
  gifResults: integer(1),
  otherResults: integer(1),
  reviveSamples: integer(1),
  likelyRepliers: integer(1),
  overFetchFactor: integer(1),
  nearDuplicateThreshold: between(0, 1, 'low'),
});

export const assertPersona = (persona) => checkRules('persona', persona, {
  recencyHalfLifeMs: above(0),
  minRecencyWeight: between(0, 1, 'low'),
});
