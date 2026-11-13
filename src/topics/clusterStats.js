import { topicText } from '../text/topicEligibility.js';

export const medianOf = (numbers) => {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Median length of what people wrote, ignoring GIFs, emoji and punctuation.
export const medianTextLength = (contents) => medianOf(contents.map((content) => topicText(content).length));

// rows: [{ author, timestamp }] -> each author's share of the rows and their newest message, largest share first.
export const authorStats = (rows) => {
  const byAuthor = new Map();
  rows.forEach(({ author, timestamp }) => {
    const entry = byAuthor.get(author) ?? { count: 0, newest: 0 };
    byAuthor.set(author, { count: entry.count + 1, newest: Math.max(entry.newest, timestamp) });
  });
  return [...byAuthor.entries()]
    .map(([author, { count, newest }]) => ({ author, share: count / rows.length, newestTimestamp: newest }))
    .sort((a, b) => b.share - a.share || (a.author < b.author ? -1 : 1));
};
