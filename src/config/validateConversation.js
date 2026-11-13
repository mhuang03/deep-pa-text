import { between, checkRules, integer } from './rules.js';

const MIN_PERSONAS = 2;

export const assertConversation = (conversation) => {
  checkRules('conversation', conversation, {
    chance: between(0, 1),
    minIntervalMs: integer(0),
    minPersonas: integer(MIN_PERSONAS),
    minMessages: integer(1),
    minDelayMs: integer(0),
    topicCandidates: integer(1),
    openerSamples: integer(0),
    avoidRecentTopics: integer(0),
    planRetries: integer(0),
    personaHits: integer(1),
    maxTopicChars: integer(1),
    maxPremiseChars: integer(1),
    arrangeAttempts: integer(1),
  });
  // Cross-field bounds: each maximum must allow the minimum it pairs with (and every persona a message).
  checkRules('conversation', conversation, {
    maxPersonas: integer(conversation.minPersonas),
    maxMessages: integer(Math.max(conversation.minMessages, conversation.maxPersonas)),
    maxDelayMs: integer(conversation.minDelayMs),
  });
  return conversation;
};
