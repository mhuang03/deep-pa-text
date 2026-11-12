const MENTION_PATTERN = '<(@!?|@&|#)\\d+>';

const lookup = (table, id, prefix) => (table?.[id] ? `${prefix}${table[id]}` : '');

const createHandleMentions = (pingCache) => (text) => {
  // Mention-only messages carry no content at all, so drop them entirely.
  if (text.replace(new RegExp(MENTION_PATTERN, 'g'), '').trim() === '') return '';
  return text
    .replace(/<@!?(\d+)>/g, (match, id) => lookup(pingCache.users, id, '@'))
    .replace(/<@&(\d+)>/g, (match, id) => lookup(pingCache.roles, id, '@'))
    .replace(/<#(\d+)>/g, (match, id) => lookup(pingCache.channels, id, '#'));
};

const tenorToGifToken = (match, slug) => {
  const terms = new Set(slug.split('-'));
  terms.delete('tenor');
  terms.delete('gif');
  return `<gif! ${Array.from(terms).join(' ')}>`;
};

const handleTenor = (text) =>
  text.replace(/https?:\/\/tenor\.com\/view\/([^/]+)-\d+(\?\S+)?/g, tenorToGifToken);

const isUrlWord = (word) => {
  if (!word.includes('://')) return false;
  const isolated = word.match(/https?:\/\/[^\s]+/);
  const candidate = (isolated ? isolated[0] : word).replace(/^<|>$/g, '');
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
};

const removeUrlOnce = (text, url) =>
  text.replace(`${url} `, '').replace(`${url}\n`, '').replace(url, '');

const removeUrls = (text) => {
  const unlinked = text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    // A newline sometimes splits the scheme from the rest of the url.
    .replace(/https?:\/\/\n/g, 'https://');
  return unlinked.split(/\s+/).filter(isUrlWord).reduce(removeUrlOnce, unlinked);
};

const replace = (pattern, replacement) => (text) => text.replace(pattern, replacement);

export const createTransformers = ({ pingCache }) => [
  { name: 'handleMentions', apply: createHandleMentions(pingCache) },
  { name: 'handleTenor', apply: handleTenor },
  { name: 'removeUrls', apply: removeUrls },
  { name: 'replaceCustomEmojis', apply: replace(/<a?(:\w+:)\d+>/g, '$1') },
  { name: 'removeDynamicTimeObjects', apply: replace(/<t:\d+(:\w+)?>/g, '') },
  { name: 'removeSoundboards', apply: replace(/<:sound:\d+:\d+>/g, '') },
  { name: 'removeDiscordLinks', apply: replace(/(https?:\/\/(www\.)?)?discord\.gg\/\S+/g, '') },
  { name: 'trim', apply: (text) => text.trim() },
];
