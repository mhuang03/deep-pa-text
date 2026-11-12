import { applyGifResults, findGifTokens } from './gifTokens.js';

export const createGifResolver = ({ engines, config }) => {
  const findUrl = async (query) => {
    for (const engine of engines) {
      const url = await engine.search(query);
      if (url !== '') return url;
    }
    return '';
  };

  const resolveToken = async ({ match, query }) => ({ match, url: await findUrl(query) });

  const resolve = async (text) => {
    const tokens = findGifTokens(text, config.gifs.maxQueryLength);
    const gifLinks = await Promise.all(tokens.map(resolveToken));
    return { content: applyGifResults(text, gifLinks), gifLinks };
  };

  return { resolve };
};
