import { withTimeout } from '../util/withTimeout.js';
import { applyGifResults, findGifTokens } from './gifTokens.js';

export const createGifResolver = ({ engines, config, random, logger, clock }) => {
  const searchEngine = async (engine, query) => {
    try {
      const search = engine.search(query);
      return await withTimeout(search, {
        ms: config.gifs.timeoutMs,
        label: engine.name,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
    } catch (error) {
      logger.warn(`GIF engine ${engine.name} failed for "${query}": ${error.message}`);
      return [];
    }
  };

  const findCandidates = async (query) => {
    for (const engine of engines) {
      const urls = await searchEngine(engine, query);
      if (urls.length > 0) return urls;
    }
    return [];
  };

  const pick = (candidates) => {
    if (candidates.length === 1) return candidates[0];
    return candidates[Math.floor(random() * candidates.length)];
  };

  const resolve = async (text) => {
    const tokens = findGifTokens(text, config.gifs.maxQueryLength);
    const lists = await Promise.all(tokens.map(({ query }) => findCandidates(query)));
    const gifLinks = tokens.map(({ match }, i) => ({ match, url: lists[i].length > 0 ? pick(lists[i]) : '' }));
    return { content: applyGifResults(text, gifLinks), gifLinks };
  };

  return { resolve };
};
