// Candidate retrieval for a reply: three Chroma buckets plus random messages, hidden rows removed.
const buildWhere = (author, timestamp, extra = []) => ({
  $and: [{ author }, { timestamp: { $lt: timestamp } }, ...extra],
});

const hitCandidate = (hit) => ({ id: hit.id, text: hit.document, embedding: null });

export const fetchLimit = ({ overFetchFactor }, limit) => limit * overFetchFactor;

// Hidden (deleted or superseded) rows stay in Chroma; SQLite decides what is visible.
const search = async ({ vectorStore, messageStore, retrieval }, collection, { embedding, where, limit }) => {
  const hits = await vectorStore.query(collection, { embedding, where, limit: fetchLimit(retrieval, limit) });
  const hidden = messageStore.hiddenIds(hits.map((hit) => hit.id));
  return hits.filter((hit) => !hidden.has(hit.id));
};

export const fetchRaw = async (ctx, { author, record, embedding }) => {
  const { messageStore, retrieval } = ctx;
  const where = buildWhere(author, record.timestamp);
  const gifWhere = buildWhere(author, record.timestamp, [{ has_gif: true }]);
  const similar = await search(ctx, 'messages', { embedding, where, limit: retrieval.similarResults });
  const replies = await search(ctx, 'replies', { embedding, where, limit: retrieval.replyResults });
  const gifs = await search(ctx, 'messages', { embedding, where: gifWhere, limit: retrieval.gifResults });
  const other = messageStore.randomMessages({
    author, before: record.timestamp, limit: fetchLimit(retrieval, retrieval.otherResults),
  }).map(({ id, content }) => ({ id, text: content, embedding: null }));
  return { replies: replies.map(hitCandidate), similar: similar.map(hitCandidate), gifs: gifs.map(hitCandidate), other };
};
