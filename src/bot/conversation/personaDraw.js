import { pickWeighted, weighAuthors } from '../../retrieval/personaWeights.js';

const HALF = 0.5;
const COLLECTION = 'messages';

// Without replacement, one roll per draw; stops early when nobody with weight is left.
const drawFrom = (entries, { limit, random }) => {
  let remaining = entries;
  const chosen = [];
  while (chosen.length < limit && remaining.length > 0) {
    const author = pickWeighted(remaining, random());
    if (author === undefined) break;
    chosen.push(author);
    remaining = remaining.filter((entry) => entry.author !== author);
  }
  return chosen;
};

// Their share of the topic, discounted the longer ago they last wrote about it.
const topicEntries = ({ candidate, now, userDirectory, settings }) => candidate.authors
  .filter(({ author }) => userDirectory.usernames.has(author))
  .map(({ author, share, newestTimestamp }) => {
    const age = Math.max(0, now - newestTimestamp);
    const recency = Math.max(settings.minRecencyWeight, HALF ** (age / settings.recencyHalfLifeMs));
    return { author, weight: share * recency };
  });

const searchHistory = async (ctx, { query, chosen }) => {
  const { vectorStore, messageStore, userDirectory, now, persona, conversation } = ctx;
  const hits = await vectorStore.query(COLLECTION, { text: query, limit: conversation.personaHits });
  const hidden = messageStore.hiddenIds(hits.map((hit) => hit.id));
  return weighAuthors(hits.filter((hit) => !hidden.has(hit.id)), {
    referenceTimeMs: now,
    halfLifeMs: persona.recencyHalfLifeMs,
    minRecency: persona.minRecencyWeight,
    missingSimilarity: persona.missingSimilarity,
    allowedAuthors: [...userDirectory.usernames].filter((username) => !chosen.includes(username)),
  });
};

// The people whose history fits the topic: the candidate's own authors first, then a search of the corpus.
export const createPersonaDraw = ({ vectorStore, messageStore, userDirectory, random, clock, config, logger }) => {
  const ctx = {
    vectorStore, messageStore, userDirectory, persona: config.persona, conversation: config.conversation,
  };

  const topUp = async ({ query, chosen, need }) => {
    try {
      const entries = await searchHistory({ ...ctx, now: clock.now() }, { query, chosen });
      return drawFrom(entries, { limit: need, random });
    } catch (error) {
      logger.warn('Could not search the history for more conversation personas; continuing without:', error);
      return [];
    }
  };

  const draw = async ({ candidate, count, query }) => {
    const entries = topicEntries({ candidate, now: clock.now(), userDirectory, settings: ctx.persona });
    const chosen = drawFrom(entries, { limit: count, random });
    if (chosen.length >= count) return chosen;
    return [...chosen, ...await topUp({ query, chosen, need: count - chosen.length })];
  };

  return { draw };
};
