import { splitBurst } from './burst.js';
import { sanitizeResponse } from './sanitize.js';

export const EMPTY_RESPONSE_MESSAGE = 'LLM returned an empty response';
export const PART_SEPARATOR = '\n<split>\n';

// Split first so a model that quotes each part separately is still unwrapped.
export const postProcess = (raw, { burst }) => {
  const parts = splitBurst(raw, burst)
    .map(sanitizeResponse)
    .filter((part) => part !== '');
  // Marked so the generator can tell this from an exhausted chat client, which has retried already.
  if (parts.length === 0) throw Object.assign(new Error(EMPTY_RESPONSE_MESSAGE), { isEmptyOutput: true });
  return { response: parts.join(PART_SEPARATOR), parts };
};
