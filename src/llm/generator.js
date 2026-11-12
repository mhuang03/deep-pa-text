import { sanitizeResponse } from './sanitize.js';
import { buildQueryText } from '../retrieval/queryText.js';
import { normalizeForDedup } from '../retrieval/normalize.js';
import {
  SYSTEM_PROMPT, REVIVE_SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt,
} from './prompts.js';

const EMPTY_RESPONSE_MESSAGE = 'LLM returned an empty response';

export const createGenerator = ({
  chatClient, retriever, userDirectory, botMessageStore, messageStore, config, logger,
}) => {
  const complete = async (user, system = SYSTEM_PROMPT) => {
    const response = sanitizeResponse(await chatClient.complete({ system, user }));
    if (response === '') throw new Error(EMPTY_RESPONSE_MESSAGE);
    return response;
  };

  // A failed load is tolerated: the prompt just omits the avoid-repeats section.
  const loadRecentBotMessages = () => {
    try {
      const rows = botMessageStore.recent({ limit: config.retrieval.recentBotMessages });
      return rows.map((row) => row.content);
    } catch (error) {
      logger?.warn?.(`Could not load recent bot messages: ${error.message}`);
      return [];
    }
  };

  const generateReply = async (persona, record, context = {}) => {
    const transcript = context.transcript ?? [];
    const queryText = buildQueryText(record, transcript, config.retrieval);
    const buckets = await retriever.retrieveForReply(persona, record, { queryText });
    const user = buildReplyPrompt({
      author: persona,
      name: userDirectory.nameOf(persona),
      message: record.content,
      messageAuthor: record.author,
      buckets,
      transcript,
      recentBotMessages: loadRecentBotMessages(),
      timeZone: config.context.timeZone,
      maxEntryChars: config.context.maxEntryChars,
    });
    return complete(user);
  };

  // A failed lookup is tolerated: the prompt just omits the starters section.
  const loadStarters = (author) => {
    const { revive, retrieval } = config;
    try {
      const rows = messageStore.randomStarters({
        author, minGapMs: revive.starterGapMs, limit: revive.starterSamples * retrieval.overFetchFactor,
      });
      const unique = new Map();
      rows.forEach((text) => {
        const key = normalizeForDedup(text);
        if (!unique.has(key)) unique.set(key, text);
      });
      return [...unique.values()].slice(0, revive.starterSamples);
    } catch (error) {
      logger?.warn?.(`Could not load conversation starters: ${error.message}`);
      return [];
    }
  };

  const generateRevive = async (persona, context = {}) => {
    const starters = loadStarters(persona);
    const taken = new Set(starters.map(normalizeForDedup));
    const examples = (await retriever.retrieveForRevive(persona))
      .filter((text) => !taken.has(normalizeForDedup(text)));
    const user = buildRevivePrompt({
      author: persona,
      name: userDirectory.nameOf(persona),
      examples,
      starters,
      transcript: context.transcript ?? [],
      quietMs: context.quietMs ?? null,
      nowMs: context.nowMs,
      timeZone: config.context.timeZone,
      recentBotMessages: loadRecentBotMessages(),
    });
    return complete(user, REVIVE_SYSTEM_PROMPT);
  };

  return { generateReply, generateRevive };
};
