const SPLIT_MARKER = /\s*<split>\s*/gi;
const JOINER = '\n';

export const splitBurst = (raw, { enabled }) => {
  const text = raw.trim();
  if (!enabled) return [text.replace(SPLIT_MARKER, JOINER)];
  return text.split(SPLIT_MARKER);
};

// Parts beyond the limit are folded into the last allowed one so no text is lost.
export const capParts = (parts, maxMessages) => {
  if (parts.length <= maxMessages) return parts;
  const kept = parts.slice(0, maxMessages - 1);
  return [...kept, parts.slice(maxMessages - 1).join(JOINER)];
};

export const burstDelay = (text, { msPerChar, minDelayMs, maxDelayMs }) =>
  Math.min(maxDelayMs, Math.max(minDelayMs, text.length * msPerChar));
