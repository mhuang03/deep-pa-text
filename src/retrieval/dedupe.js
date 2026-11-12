import { normalizeForDedup } from '../text/normalize.js';
import { cosineSimilarity } from './similarity.js';

const isNearDuplicate = (a, b, { nearDuplicateThreshold, nearDuplicateMinChars }) => {
  if (!a.item.embedding || !b.item.embedding) return false;
  if (a.key.length < nearDuplicateMinChars || b.key.length < nearDuplicateMinChars) return false;
  return cosineSimilarity(a.item.embedding, b.item.embedding) >= nearDuplicateThreshold;
};

// Key equality is checked against every kept item before any embedding comparison.
const findMatch = (kept, entry, options) =>
  kept.find((other) => other.key === entry.key)
  ?? kept.find((other) => isNearDuplicate(other, entry, options));

const mergeInto = (match, text) => {
  if (!match.item.variants.includes(text)) match.item.variants.push(text);
};

const toEntry = (candidate) => ({
  key: normalizeForDedup(candidate.text),
  item: { ...candidate, variants: [candidate.text] },
});

// Greedy and order dependent: earlier buckets and earlier candidates win, across buckets. A bucket's limit
// applies during the pass: once it is full, its remaining candidates are skipped without being merged
// anywhere, so they cannot suppress duplicates in later buckets. Without limits a bucket is unbounded.
export const dedupeBuckets = (buckets, { limits = [], ...options } = {}) => {
  const kept = [];
  return buckets.map((bucket, index) => {
    const limit = limits[index] ?? Infinity;
    const result = [];
    bucket.forEach((candidate) => {
      if (result.length >= limit) return;
      const entry = toEntry(candidate);
      const match = findMatch(kept, entry, options);
      if (match) return mergeInto(match, candidate.text);
      kept.push(entry);
      result.push(entry.item);
    });
    return result;
  });
};
