import { postProcess } from './postProcess.js';
import { buildQueryText } from '../retrieval/queryText.js';
import { normalizeForDedup } from '../retrieval/normalize.js';
import {
  SYSTEM_PROMPT, REVIVE_SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt, buildChainPrompt,
} from './prompts.js';

export const createGenerator = ({
  chatClient, retriever, userDirectory, botMessageStore, messageStore, burstProfile, config, logger,
}) => {
  // Output that sanitises to nothing is worth another completion; a failed chat client is not retried here.
  const complete = async (user, system = SYSTEM_PROMPT, turns = null) => {
    const request = turns ? { system, user, turns } : { system, user };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return postProcess(await chatClient.complete(request), { burst: config.burst });
      } catch (error) {
        if (!error.isEmptyOutput || attempt >= config.llm.postProcessRetries) throw error;
        logger?.warn?.('Model output was empty after cleaning; requesting a new completion');
      }
    }
  };

  // A failed measurement is tolerated: the prompt just omits the burst section.
  const loadBurstRate = (persona) => {
    if (!config.burst.enabled) return 0;
    try {
      return burstProfile.rateFor(persona);
    } catch (error) {
      logger?.warn?.(`Could not measure the burst rate: ${error.message}`);
      return 0;
    }
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

  // The thread is the conversation: earlier turns go to the model as chat turns, not as prompt text.
  const generateChainReply = async (persona, record, chain) => {
    const queryText = buildQueryText(record, chain.turns.slice(0, -1), config.retrieval);
    const buckets = await retriever.retrieveForReply(persona, record, { queryText });
    const user = buildChainPrompt({
      author: persona,
      name: userDirectory.nameOf(persona),
      buckets,
      recentBotMessages: loadRecentBotMessages(),
      burstRate: loadBurstRate(persona),
      burst: config.burst,
      maxEntryChars: config.context.maxEntryChars,
    });
    return complete(user, SYSTEM_PROMPT, chain.turns);
  };

  const generateReply = async (persona, record, context = {}) => {
    if (context.chain) return generateChainReply(persona, record, context.chain);
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
      burstRate: loadBurstRate(persona),
      burst: config.burst,
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
      burstRate: loadBurstRate(persona),
      burst: config.burst,
    });
    return complete(user, REVIVE_SYSTEM_PROMPT);
  };

  return { generateReply, generateRevive };
};
