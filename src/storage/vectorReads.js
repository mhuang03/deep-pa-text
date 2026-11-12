import { namedCollection } from './vectorCollections.js';
import { QUERY_INCLUDE, hasEmbedding, toHits, buildQueryInput } from './vectorRecords.js';

const embed = async ({ guard, embeddingFunction }, text) => {
  const [embedding] = await guard.timed('embed', guard.limits.interactive, () => embeddingFunction.generate([text]));
  return embedding;
};

const getEmbeddings = async ({ guard, collections }, ids) => {
  if (ids.length === 0) return new Map();
  const { timed, limits } = guard;
  const { messages } = await collections(limits.interactive);
  const found = await timed('getEmbeddings', limits.interactive, () => messages.get({ ids, include: ['embeddings'] }));
  const entries = found.ids.map((id, i) => [id, found.embeddings?.[i]]);
  return new Map(entries.filter(([, embedding]) => hasEmbedding(embedding)));
};

// Stored rows as Chroma holds them, so a repair can pass them back unchanged.
const getRecords = async ({ guard, collections }, name, ids) => {
  if (ids.length === 0) return new Map();
  const { timed, limits } = guard;
  const target = await namedCollection(collections, name, limits.batch);
  const found = await timed('getRecords', limits.batch, () => target.get({
    ids, include: ['documents', 'metadatas', 'embeddings'],
  }));
  return new Map(found.ids.map((id, i) => [id, {
    document: found.documents?.[i],
    metadata: found.metadatas?.[i],
    embedding: found.embeddings?.[i],
  }]));
};

const query = async ({ guard, collections }, name, { embedding, text, where, limit }) => {
  const { timed, limits } = guard;
  const input = buildQueryInput({ embedding, text });
  const target = await namedCollection(collections, name, limits.interactive);
  const result = await timed('query', limits.interactive, () => target.query({
    ...input, nResults: limit, where, include: QUERY_INCLUDE,
  }));
  return toHits(result);
};

export const createVectorReads = ({ guard, collections, embeddingFunction }) => {
  const ctx = { guard, collections, embeddingFunction };
  return {
    embed: (text) => embed(ctx, text),
    getEmbeddings: (ids) => getEmbeddings(ctx, ids),
    getRecords: (name, ids) => getRecords(ctx, name, ids),
    query: (name, options) => query(ctx, name, options),
  };
};
