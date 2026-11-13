import { parseBoolean } from './parse.js';

// Scripted conversation tunables (spec 35). Only the on/off switch has an environment override.
export const buildConversation = (env) => ({
  enabled: parseBoolean(env, 'CONVERSATIONS', true),
  chance: 0.1,
  minIntervalMs: 86400000,
  minPersonas: 2,
  maxPersonas: 5,
  minMessages: 3,
  maxMessages: 6,
  minDelayMs: 5000,
  maxDelayMs: 30000,
  topicCandidates: 5,
  openerSamples: 6,
  avoidRecentTopics: 10,
  planRetries: 1,
  personaHits: 60,
  maxTopicChars: 80,
  maxPremiseChars: 300,
  arrangeAttempts: 50,
});
