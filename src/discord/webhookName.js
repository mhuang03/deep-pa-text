// Discord rejects webhook usernames containing these words, in any case.
const FORBIDDEN_WORDS = /clyde|discord/i;

const cutToCodePoints = (text, max) => Array.from(text).slice(0, max).join('');

const usable = (candidate) => candidate.trim() !== '' && !FORBIDDEN_WORDS.test(candidate);

export const toWebhookName = (displayName, username, max) => {
  for (const source of [displayName, username]) {
    const candidate = cutToCodePoints(source ?? '', max);
    if (usable(candidate)) return candidate;
  }
  return null;
};
