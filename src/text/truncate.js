const SURROGATE_RANGE = { high: [0xD800, 0xDBFF], low: [0xDC00, 0xDFFF] };

// Cuts by code points so a surrogate pair is never split; the ellipsis is appended only when text was cut.
export const truncateCodePoints = (text, max, { ellipsis = '' } = {}) => {
  const points = Array.from(text);
  if (!(points.length > max)) return text;
  return `${points.slice(0, max).join('')}${ellipsis}`;
};

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
