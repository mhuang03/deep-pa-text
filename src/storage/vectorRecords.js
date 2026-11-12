export const QUERY_INCLUDE = ['documents', 'metadatas', 'distances'];

const buildMetadata = (m) => ({ author: m.author, timestamp: m.timestamp, has_gif: Boolean(m.hasGif) });

export const hasEmbedding = (embedding) => Array.isArray(embedding) && embedding.length > 0;

// Chroma rejects a batch that repeats an id; the last occurrence wins.
export const dedupeById = (items, idOf) => [...new Map(items.map((item) => [idOf(item), item])).values()];

export const toHits = (result) =>
  result.ids[0].map((id, i) => ({
    id,
    document: result.documents[0][i],
    metadata: result.metadatas[0][i],
    distance: result.distances[0][i],
  }));

export const buildQueryInput = ({ embedding, text }) => {
  if ((embedding === undefined) === (text === undefined)) {
    throw new Error('vectorStore.query requires exactly one of embedding or text');
  }
  return embedding === undefined ? { queryTexts: [text] } : { queryEmbeddings: [embedding] };
};

export const toUpsertBody = (rows) => ({
  ids: rows.map((m) => m.id),
  documents: rows.map((m) => m.content),
  metadatas: rows.map(buildMetadata),
});
