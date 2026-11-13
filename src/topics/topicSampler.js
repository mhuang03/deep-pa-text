import { isTopicEligible } from '../text/topicEligibility.js';
import { normalizeForDedup } from '../text/normalize.js';

// Rows that could take part in a topic: long enough, written by a directory member, not a stock phrase.
const eligibleRows = (rows, { settings, userDirectory }) => rows.filter((row) =>
  userDirectory.usernames.has(row.author) && isTopicEligible(row.content, settings));

const withoutStockPhrases = (rows, maxRepeats) => {
  const counts = new Map();
  rows.forEach((row) => {
    const key = normalizeForDedup(row.content);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return rows.filter((row) => counts.get(normalizeForDedup(row.content)) <= maxRepeats);
};

// Each group is cut to its share; a short group lets the other fill the remainder.
const cutGroups = ({ recent, older }, { recentLimit, olderLimit, maxMessages }) => {
  const taken = [...recent.slice(0, recentLimit), ...older.slice(0, olderLimit)];
  const spare = [...recent.slice(recentLimit), ...older.slice(olderLimit)];
  return [...taken, ...spare.slice(0, Math.max(0, maxMessages - taken.length))];
};

export const createTopicSampler = ({ messageStore, userDirectory, config }) => {
  const settings = config.topics;
  // `sampled` counts rows read; `rows` are the eligible ones after the cut.
  const sample = ({ maxMessages, now }) => {
    const recentLimit = Math.round(maxMessages * settings.recentShare);
    const olderLimit = maxMessages - recentLimit;
    const sinceMs = now - settings.recentWindowMs;
    const fetched = messageStore.topicSample({
      minChars: settings.minChars,
      sinceMs,
      recentLimit: recentLimit * settings.sampleOverFetch,
      olderLimit: olderLimit * settings.sampleOverFetch,
    });
    const kept = withoutStockPhrases(eligibleRows(fetched, { settings, userDirectory }), settings.maxPhraseRepeats);
    const groups = {
      recent: kept.filter((row) => row.timestamp >= sinceMs),
      older: kept.filter((row) => row.timestamp < sinceMs),
    };
    return { sampled: fetched.length, rows: cutGroups(groups, { recentLimit, olderLimit, maxMessages }) };
  };
  return { sample };
};
