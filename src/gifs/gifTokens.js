export const findGifTokens = (text, maxQueryLength) =>
  [...text.matchAll(/<gif!(.*?)>/g)].map((match) => ({
    match: match[0],
    query: match[1].trim().slice(0, maxQueryLength),
  }));

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
