import { isTopicEligible } from '../text/topicEligibility.js';
import { normalizeForDedup } from '../text/normalize.js';
import { authorStats, medianTextLength } from './clusterStats.js';

const COLLECTION = 'messages';
const MIN_AUTHORS = 2;

const isUsableHit = (hit, { settings, userDirectory, hidden }) =>
  !hidden.has(hit.id)
  && userDirectory.usernames.has(hit.metadata?.author)
  && isTopicEligible(hit.document ?? '', settings);

const dedupeHits = (hits) => {
  const seen = new Set();
  return hits.filter((hit) => {
    const key = normalizeForDedup(hit.document);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const toRows = (hits) => hits.map((hit) => ({
  author: hit.metadata.author, timestamp: hit.metadata.timestamp ?? 0, content: hit.document,
}));

// A neighbourhood is a topic only when enough different messages by different people sit close together.
const qualifies = (hits, settings) => {
  if (hits.length < settings.minNeighbours) return false;
  if (new Set(hits.map((hit) => hit.metadata.author)).size < MIN_AUTHORS) return false;
  return medianTextLength(hits.map((hit) => hit.document)) >= settings.minMedianChars;
};

const toCandidate = (hits, settings) => ({
  topicId: null,
  label: null,
  summary: null,
  authors: authorStats(toRows(hits)),
  samples: hits.slice(0, settings.conversationSamples).map((hit) => ({ author: hit.metadata.author, text: hit.document })),
});

const neighboursOf = async (ctx, seed) => {
  const { vectorStore, messageStore, settings } = ctx;
  const embedding = (await vectorStore.getEmbeddings([seed.id])).get(seed.id);
  if (!embedding) return null;
  const hits = await vectorStore.query(COLLECTION, { embedding, limit: settings.neighbourhoodSize });
  const hidden = messageStore.hiddenIds(hits.map((hit) => hit.id));
  return dedupeHits(hits.filter((hit) => isUsableHit(hit, { ...ctx, hidden })));
};

const bestNeighbourhood = async (ctx, seeds) => {
  let best = null;
  for (const seed of seeds) {
    const hits = await neighboursOf(ctx, seed);
    if (!hits || !qualifies(hits, ctx.settings)) continue;
    const score = hits.length * new Set(hits.map((hit) => hit.metadata.author)).size;
    if (!best || score > best.score) best = { score, hits };
  }
  return best;
};

// Used only while the bank is empty: no clustering, one seeded neighbourhood of the corpus.
export const createNeighbourhood = ({ messageStore, vectorStore, userDirectory, config, logger }) => {
  const settings = config.topics;
  const find = async () => {
    try {
      const pool = messageStore.randomCorpus({ minChars: settings.minChars, limit: settings.fallbackSeeds * 4 });
      const seeds = pool.filter((row) => isTopicEligible(row.content, settings)).slice(0, settings.fallbackSeeds);
      const best = await bestNeighbourhood({ vectorStore, messageStore, userDirectory, settings }, seeds);
      return best ? [toCandidate(best.hits, settings)] : [];
    } catch (error) {
      logger.warn('Topic neighbourhood search failed:', error);
      return [];
    }
  };
  return { find };
};
