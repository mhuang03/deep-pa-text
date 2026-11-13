import { normalizeForDedup } from '../text/normalize.js';

// The cluster's rows closest to its centre, without repeated phrases and without one author dominating.
// members: row indexes; similarity(row) is the row's similarity to the centre.
export const pickRepresentatives = ({ members, rows, similarity, limit }) => {
  const perAuthor = Math.ceil(limit / 2);
  const ordered = [...members].sort((a, b) => similarity(b) - similarity(a) || a - b);
  const seen = new Set();
  const counts = new Map();
  const picked = [];
  for (const index of ordered) {
    if (picked.length >= limit) break;
    const { author, content } = rows[index];
    const key = normalizeForDedup(content);
    if (seen.has(key) || (counts.get(author) ?? 0) >= perAuthor) continue;
    seen.add(key);
    counts.set(author, (counts.get(author) ?? 0) + 1);
    picked.push(rows[index]);
  }
  return picked;
};
