const MIN_WRAPPED_LENGTH = 2;
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”' };
const STRAY_ESCAPES = [[/\\n/g, '\n'], [/\\"/g, '"'], [/\\t/g, '\t']];

// A quote is escaped when an odd number of backslashes precede it.
const hasUnescapedQuote = (inner, quotes) => {
  let backslashes = 0;
  for (const char of inner) {
    if (char === '\\') backslashes += 1;
    else {
      if (quotes.includes(char) && backslashes % 2 === 0) return true;
      backslashes = 0;
    }
  }
  return false;
};

// Only a single quoted unit is unwrapped: `"yes" or "no"` is two units and stays as written.
const isWrapped = (text) => {
  if (text.length < MIN_WRAPPED_LENGTH || QUOTE_PAIRS[text[0]] !== text.at(-1)) return false;
  return !hasUnescapedQuote(text.slice(1, -1), [text[0], text.at(-1)]);
};

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

// Each unwrap shortens the text, so the loop ends.
export const unwrapQuotes = (text) => {
  let current = text;
  while (isWrapped(current)) current = unwrapOnce(current);
  return current;
};

const replaceStrayEscapes = (text) =>
  STRAY_ESCAPES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);

const clean = (text) => replaceStrayEscapes(unwrapQuotes(text.trim())).trim();

// Repeats until nothing changes (every change shortens the text), so the result is a fixed point.
export const sanitizeResponse = (text) => {
  let current = text.trim();
  for (;;) {
    const next = clean(current);
    if (next === current) return current;
    current = next;
  }
};
