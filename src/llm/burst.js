const SPLIT_MARKER = /\s*<split>\s*/gi;
const JOINER = '\n';

const dropEmpty = (parts) => parts.map((part) => part.trim()).filter((part) => part !== '');

// Parts beyond the limit are folded into the last allowed one so no text is lost.
const capParts = (parts, maxMessages) => {
  if (parts.length <= maxMessages) return parts;
  const kept = parts.slice(0, maxMessages - 1);
  return [...kept, parts.slice(maxMessages - 1).join(JOINER)];
};

export const splitBurst = (raw, { maxMessages, enabled }) => {
  const text = raw.trim();
  if (!enabled) return [text.replace(SPLIT_MARKER, JOINER)];
  return capParts(dropEmpty(text.split(SPLIT_MARKER)), maxMessages);
};

export const burstDelay = (text, { msPerChar, minDelayMs, maxDelayMs }) =>
  Math.min(maxDelayMs, Math.max(minDelayMs, text.length * msPerChar));
