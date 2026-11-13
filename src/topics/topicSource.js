import { isTopicEligible } from '../text/topicEligibility.js';
import { normalizeForDedup } from '../text/normalize.js';
import { createNeighbourhood } from './neighbourhood.js';

const HALF = 0.5;

const weightOf = (topic, { settings, now }) => {
  const age = Math.max(0, now - topic.medianTimestamp);
  const recency = Math.max(settings.recencyFloor, HALF ** (age / settings.recencyHalfLifeMs));
  return recency * Math.log(1 + topic.size);
};

// One roll per draw; a draw removes the topic from the pool.
const drawWeighted = (pool, { limit, random }, weigh) => {
  const remaining = [...pool];
  const drawn = [];
  while (drawn.length < limit && remaining.length > 0) {
    const weights = remaining.map(weigh);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const target = random() * total;
    let cumulative = 0;
    let index = remaining.length - 1;
    for (let i = 0; i < remaining.length; i += 1) {
      cumulative += weights[i];
      if (target < cumulative) {
        index = i;
        break;
      }
    }
    drawn.push(...remaining.splice(index, 1));
  }
  return drawn;
};

const MIN_AUTHORS = 2;

// Only people in the directory may take part; a topic they cannot carry between two of them is useless.
const usableTopics = (topics, { userDirectory, excludeTopicIds }) => topics
  .filter((topic) => !excludeTopicIds.includes(topic.id))
  .map((topic) => ({ ...topic, authors: topic.authors.filter((a) => userDirectory.usernames.has(a.author)) }))
  .filter((topic) => topic.authors.length >= MIN_AUTHORS);

const toCandidate = (topic, samples) => ({
  topicId: topic.id, label: topic.label, summary: topic.summary, authors: topic.authors, samples,
});

const fromBank = (ctx, { limit, excludeTopicIds }) => {
  const { topicStore, userDirectory, random, clock, settings } = ctx;
  const pool = usableTopics(topicStore.currentTopics(), { userDirectory, excludeTopicIds });
  const now = clock.now();
  return drawWeighted(pool, { limit, random }, (topic) => weightOf(topic, { settings, now }))
    .map((topic) => toCandidate(topic, topicStore.samplesOf(topic.id, settings.conversationSamples)))
    .filter((candidate) => candidate.samples.length > 0);
};

const startersOf = ({ messageStore, config }, limit) => messageStore.randomStartersAll({
  minGapMs: config.revive.starterGapMs, limit: limit * config.retrieval.overFetchFactor,
});

const distinctByKey = () => {
  const seen = new Set();
  return (row) => {
    const key = normalizeForDedup(row.content);
    return !seen.has(key) && seen.add(key);
  };
};

const statusOf = ({ topicStore, clock, settings }) => {
  const build = topicStore.currentBuild();
  const stale = build === null || clock.now() - build.completedAt > settings.maxAgeMs;
  return { topics: topicStore.currentTopics().length, completedAt: build?.completedAt ?? null, stale };
};

export const createTopicSource = (deps) => {
  const { topicStore, userDirectory, random, clock, config, logger } = deps;
  const settings = config.topics;
  const ctx = { topicStore, userDirectory, random, clock, settings };
  const neighbourhood = createNeighbourhood(deps);

  // The bank first; the neighbourhood search only while the bank offers nothing.
  const candidates = async ({ limit, excludeTopicIds = [] }) => {
    const banked = fromBank(ctx, { limit, excludeTopicIds });
    return banked.length > 0 ? banked : neighbourhood.find();
  };

  // Synchronous on purpose: callers may await it or not.
  const openers = ({ limit }) => {
    try {
      return startersOf(deps, limit)
        .filter((row) => userDirectory.usernames.has(row.author) && isTopicEligible(row.content, settings))
        .filter(distinctByKey())
        .slice(0, limit)
        .map((row) => ({ author: row.author, text: row.content }));
    } catch (error) {
      logger.warn('Topic openers lookup failed:', error);
      return [];
    }
  };

  return { candidates, openers, bankStatus: () => statusOf(ctx) };
};
