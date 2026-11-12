import { dedupeBuckets } from './dedupe.js';

export const BUCKET_ORDER = ['replies', 'similar', 'gifs', 'other'];

const documentsOf = (hits) => hits.map((hit) => hit.document);

// Nearest hit wins when several share a document.
const idsByDocument = (hits) => {
  const ids = new Map();
  hits.forEach((hit) => {
    if (!ids.has(hit.document)) ids.set(hit.document, hit.id);
  });
  return ids;
};

const buildExamples = (documents, ids, parents) =>
  documents.map((you) => ({ you, them: parents.get(ids.get(you))?.content ?? null }));

const buildWhere = (author, timestamp, extra = []) => ({
  $and: [{ author }, { timestamp: { $lt: timestamp } }, ...extra],
});

export const createRetriever = ({ vectorStore, messageStore, config }) => {
  const { retrieval } = config;

  const search = async (collection, { embedding, where, limit }) =>
    documentsOf(await vectorStore.query(collection, { embedding, where, limit }));

  const retrieveForReply = async (author, record, { queryText } = {}) => {
    const embedding = await vectorStore.embed(queryText ?? record.content);
    const where = buildWhere(author, record.timestamp);
    const gifWhere = buildWhere(author, record.timestamp, [{ has_gif: true }]);
    const similar = await search('messages', { embedding, where, limit: retrieval.similarResults });
    const replyHits = await vectorStore.query('replies', {
      embedding, where, limit: retrieval.replyResults,
    });
    const replies = documentsOf(replyHits);
    const gifs = await search('messages', {
      embedding, where: gifWhere, limit: retrieval.gifResults,
    });
    const other = messageStore.randomContents({
      author, before: record.timestamp, limit: retrieval.otherResults,
    });
    const raw = { replies, similar, gifs, other };
    const deduped = dedupeBuckets(BUCKET_ORDER.map((key) => raw[key]));
    const result = Object.fromEntries(BUCKET_ORDER.map((key, i) => [key, deduped[i]]));
    const ids = idsByDocument(replyHits);
    const parents = messageStore.getParents(result.replies.map((document) => ids.get(document)));
    return { ...result, replies: buildExamples(result.replies, ids, parents) };
  };

  const retrieveForRevive = async (author) =>
    messageStore.randomContents({ author, limit: retrieval.reviveSamples });

  return { retrieveForReply, retrieveForRevive };
};
