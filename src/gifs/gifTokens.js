import { truncateCodePoints } from '../util/text.js';

const TOKEN_PATTERN = /<gif!(.*?)>/g;

export const findGifTokens = (text, maxQueryLength) =>
  [...text.matchAll(TOKEN_PATTERN)].map((match) => ({
    match: match[0],
    query: truncateCodePoints(match[1].trim(), maxQueryLength),
  }));

// Keeps the first `max` tokens and removes the rest outright: no placeholder for what was never asked for.
export const limitGifTokens = (text, max) => {
  let seen = 0;
  return text.replace(TOKEN_PATTERN, (token) => {
    seen += 1;
    return seen > max ? '' : token;
  });
};

const PLACEHOLDER_PREFIX = '<INSERT GIF: ';
const TOKEN_PREFIX_LENGTH = '<gif!'.length;

const replaceFirst = (text, target, replacement) => {
  const index = text.indexOf(target);
  if (index === -1) return text;
  return text.slice(0, index) + replacement + text.slice(index + target.length);
};

const replacementFor = ({ match, url }) =>
  url ? '' : PLACEHOLDER_PREFIX + match.slice(TOKEN_PREFIX_LENGTH);

export const applyGifResults = (text, gifLinks) =>
  gifLinks.reduce((content, link) => replaceFirst(content, link.match, replacementFor(link)), text);
