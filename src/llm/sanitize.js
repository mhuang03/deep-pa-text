const MAX_UNWRAPS = 3;
const MIN_WRAPPED_LENGTH = 2;
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”' };
const STRAY_ESCAPES = [[/\\n/g, '\n'], [/\\"/g, '"'], [/\\t/g, '\t']];
const SURROGATE_RANGE = { high: [0xD800, 0xDBFF], low: [0xDC00, 0xDFFF] };

const isWrapped = (text) =>
  text.length >= MIN_WRAPPED_LENGTH && QUOTE_PAIRS[text[0]] === text.at(-1);

const parseJsonString = (text) => {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

const unwrapOnce = (text) => {
  const parsed = text[0] === '"' ? parseJsonString(text) : null;
  return (parsed ?? text.slice(1, -1)).trim();
};

const unwrapQuotes = (text) => {
  let current = text;
  for (let i = 0; i < MAX_UNWRAPS && isWrapped(current); i += 1) current = unwrapOnce(current);
  return current;
};

const replaceStrayEscapes = (text) =>
  STRAY_ESCAPES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);

export const sanitizeResponse = (text) =>
  replaceStrayEscapes(unwrapQuotes(text.trim())).trim();

const isInRange = (code, [low, high]) => code >= low && code <= high;

const splitsSurrogatePair = (text, cut) =>
  isInRange(text.charCodeAt(cut - 1), SURROGATE_RANGE.high)
  && isInRange(text.charCodeAt(cut), SURROGATE_RANGE.low);

const findWhitespaceCut = (cutText, lookback) => {
  const from = Math.max(0, cutText.length - lookback);
  for (let i = cutText.length - 1; i >= from; i -= 1) {
    if (/\s/.test(cutText[i])) return i;
  }
  return -1;
};

export const truncateForDiscord = (content, { maxLength, lookback }) => {
  if (content.length <= maxLength) return content;
  const cut = splitsSurrogatePair(content, maxLength) ? maxLength - 1 : maxLength;
  const cutText = content.slice(0, cut);
  const space = findWhitespaceCut(cutText, lookback);
  const result = space >= 0 && cutText.slice(0, space).trim() !== '' ? cutText.slice(0, space) : cutText;
  return result.trimEnd();
};
