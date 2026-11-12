// Optional prompt inputs. Every failure is tolerated: the prompt just omits that section.
import { normalizeForDedup } from '../text/normalize.js';

const burstRate = ({ burstProfile, config, logger }, persona) => {
  if (!config.burst.enabled) return 0;
  try {
    return burstProfile.rateFor(persona);
  } catch (error) {
    logger?.warn?.(`Could not measure the burst rate: ${error.message}`);
    return 0;
  }
};

const recentBotMessages = ({ botMessageStore, config, logger }) => {
  try {
    const rows = botMessageStore.recent({ limit: config.retrieval.recentBotMessages });
    return rows.map((row) => row.content);
  } catch (error) {
    logger?.warn?.(`Could not load recent bot messages: ${error.message}`);
    return [];
  }
};

const uniqueByKey = (rows) => {
  const unique = new Map();
  rows.forEach((text) => {
    const key = normalizeForDedup(text);
    if (!unique.has(key)) unique.set(key, text);
  });
  return [...unique.values()];
};

const starters = ({ messageStore, config, logger }, author) => {
  const { revive, retrieval } = config;
  try {
    const rows = messageStore.randomStarters({
      author, minGapMs: revive.starterGapMs, limit: revive.starterSamples * retrieval.overFetchFactor,
    });
    return uniqueByKey(rows).slice(0, revive.starterSamples);
  } catch (error) {
    logger?.warn?.(`Could not load conversation starters: ${error.message}`);
    return [];
  }
};

export const createGeneratorInputs = (deps) => ({
  burstRate: (persona) => burstRate(deps, persona),
  recentBotMessages: () => recentBotMessages(deps),
  starters: (author) => starters(deps, author),
});
