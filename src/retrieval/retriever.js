import { dedupeBuckets } from './dedupe.js';
import { buildFrequent } from './frequency.js';

export const BUCKET_ORDER = ['replies', 'similar', 'gifs', 'other'];

const buildWhere = (author, timestamp, extra = []) => ({
  $and: [{ author }, { timestamp: { $lt: timestamp } }, ...extra],
});

const hitCandidate = (hit) => ({ id: hit.id, text: hit.document, embedding: null });

const withEmbeddings = (candidates, embeddings) =>
  candidates.map((candidate) => ({ ...candidate, embedding: embeddings.get(candidate.id) ?? null }));

export const createRetriever = ({ vectorStore, messageStore, config, logger }) => {
  const { retrieval } = config;
  const fetchLimit = (limit) => limit * retrieval.overFetchFactor;
  const dedupeOptions = {
    nearDuplicateThreshold: retrieval.nearDuplicateThreshold,
    nearDuplicateMinChars: retrieval.nearDuplicateMinChars,
  };

  const search = (collection, { embedding, where, limit }) =>
    vectorStore.query(collection, { embedding, where, limit: fetchLimit(limit) });

  const fetchRaw = async (author, record, embedding) => {
    const where = buildWhere(author, record.timestamp);
    const gifWhere = buildWhere(author, record.timestamp, [{ has_gif: true }]);
    const similar = await search('messages', { embedding, where, limit: retrieval.similarResults });
    const replies = await search('replies', { embedding, where, limit: retrieval.replyResults });
    const gifs = await search('messages', { embedding, where: gifWhere, limit: retrieval.gifResults });
    const other = messageStore.randomMessages({
      author, before: record.timestamp, limit: fetchLimit(retrieval.otherResults),
    }).map(({ id, content }) => ({ id, text: content, embedding: null }));
    return { replies: replies.map(hitCandidate), similar: similar.map(hitCandidate), gifs: gifs.map(hitCandidate), other };
  };

  // Embeddings are optional: without them dedup falls back to normalised keys.
  const loadEmbeddings = async (ids) => {
    try {
      return await vectorStore.getEmbeddings(ids);
    } catch (error) {
      logger?.warn?.(`Could not load embeddings for dedup: ${error.message}`);
      return new Map();
    }
  };

  const dedupeRaw = async (raw) => {
    const ids = Array.from(new Set(BUCKET_ORDER.flatMap((key) => raw[key].map((c) => c.id))));
    const embeddings = await loadEmbeddings(ids);
    const deduped = dedupeBuckets(BUCKET_ORDER.map((key) => withEmbeddings(raw[key], embeddings)), dedupeOptions);
    const limits = [retrieval.replyResults, retrieval.similarResults, retrieval.gifResults, retrieval.otherResults];
    return Object.fromEntries(BUCKET_ORDER.map((key, i) => [key, deduped[i].slice(0, limits[i])]));
  };

  const countAll = (author, kept, before) => {
    const contents = BUCKET_ORDER.flatMap((key) => kept[key].flatMap((item) => item.variants));
    return messageStore.countContents({ author, contents, before });
  };

  const buildReplyExamples = (items) => {
    const parents = messageStore.getParents(items.map((item) => item.id));
    return items.map((item) => ({ you: item.text, them: parents.get(item.id)?.content ?? null }));
  };

  const retrieveForReply = async (author, record, { queryText } = {}) => {
    const embedding = await vectorStore.embed(queryText ?? record.content);
    const kept = await dedupeRaw(await fetchRaw(author, record, embedding));
    const counts = countAll(author, kept, record.timestamp);
    const frequent = buildFrequent(BUCKET_ORDER.flatMap((key) => kept[key]), counts, retrieval);
    const texts = (key) => kept[key].map((item) => item.text);
    return {
      replies: buildReplyExamples(kept.replies),
      similar: texts('similar'),
      gifs: texts('gifs'),
      other: texts('other'),
      frequent,
    };
  };

  const retrieveForRevive = async (author) => {
    const rows = messageStore.randomMessages({
      author, limit: fetchLimit(retrieval.reviveSamples),
    });
    const candidates = rows.map(({ id, content }) => ({ id, text: content, embedding: null }));
    const [kept] = dedupeBuckets([candidates], dedupeOptions);
    return kept.slice(0, retrieval.reviveSamples).map((item) => item.text);
  };

  return { retrieveForReply, retrieveForRevive };
};
