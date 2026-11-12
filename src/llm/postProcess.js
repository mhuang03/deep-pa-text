import { splitBurst, capParts } from './burst.js';
import { sanitizeResponse, unwrapQuotes } from './sanitize.js';
import { stripLinks } from '../util/links.js';
import { limitGifTokens } from '../gifs/gifTokens.js';

export const EMPTY_RESPONSE_MESSAGE = 'LLM returned an empty response';
export const PART_SEPARATOR = '\n<split>\n';

const DOUBLE_QUOTE = '"';

const isEmpty = (part) => part === '';

// A quote left over from splitting a quoted answer has no partner in its part.
const dropDanglingQuote = (part) => {
  const count = part.split(DOUBLE_QUOTE).length - 1;
  if (count !== 1 || !(part.startsWith(DOUBLE_QUOTE) || part.endsWith(DOUBLE_QUOTE))) return part;
  return part.replace(DOUBLE_QUOTE, '').trim();
};

const cleanPart = (part) => stripLinks(dropDanglingQuote(sanitizeResponse(part))).trim();

// Unwrap the whole answer, split without merging, clean each part, then merge the overflow
// so quotes and links are handled before parts are combined; the GIF cap applies per delivered message.
export const postProcess = (raw, { burst, maxGifsPerMessage }) => {
  const whole = unwrapQuotes(raw.trim());
  const cleaned = splitBurst(whole, burst).map(cleanPart).filter((part) => !isEmpty(part));
  const parts = capParts(cleaned, burst.maxMessages)
    .map((part) => limitGifTokens(part, maxGifsPerMessage).trim())
    .filter((part) => !isEmpty(part));
  // Marked so the generator can tell this from an exhausted chat client, which has retried already.
  if (parts.length === 0) throw Object.assign(new Error(EMPTY_RESPONSE_MESSAGE), { isEmptyOutput: true });
  return { response: parts.join(PART_SEPARATOR), parts };
};
