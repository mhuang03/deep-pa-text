import { dedupeBuckets } from './dedupe.js';

export const BUCKET_ORDER = ['replies', 'similar', 'gifs', 'other'];

const documentsOf = (hits) => hits.map((hit) => hit.document);

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
    const replies = await search('replies', { embedding, where, limit: retrieval.replyResults });
    const gifs = await search('messages', {
      embedding, where: gifWhere, limit: retrieval.gifResults,
    });
    const other = messageStore.randomContents({
      author, before: record.timestamp, limit: retrieval.otherResults,
    });
    const raw = { replies, similar, gifs, other };
    const deduped = dedupeBuckets(BUCKET_ORDER.map((key) => raw[key]));
    return Object.fromEntries(BUCKET_ORDER.map((key, i) => [key, deduped[i]]));
  };

  const retrieveForRevive = async (author) =>
    messageStore.randomContents({ author, limit: retrieval.reviveSamples });

  return { retrieveForReply, retrieveForRevive };
};
