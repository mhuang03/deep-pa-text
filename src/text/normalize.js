const GIF_PREFIX = '<gif!';
const LETTER_RUN = /(\p{L})\1{2,}/gu;
const EDGE_NOISE = /^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu;

const squashWhitespace = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// Stretched letters ("sooooo") collapse to one; shared by the dedup key and the topic guards.
export const collapseStretched = (text) => text.replace(LETTER_RUN, '$1');

// Spellings that differ only in case, spacing, stretched letters or edge punctuation share a key.
export const normalizeForDedup = (text) => {
  const base = squashWhitespace(String(text));
  if (base.startsWith(GIF_PREFIX)) return base;
  const stripped = collapseStretched(base).replace(EDGE_NOISE, '').trim();
  return stripped === '' ? base : stripped;
};
