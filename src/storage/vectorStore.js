const QUERY_INCLUDE = ['documents', 'metadatas', 'distances'];

const buildMetadata = (m) => ({ author: m.author, timestamp: m.timestamp, has_gif: Boolean(m.hasGif) });

const toHits = (result) =>
  result.ids[0].map((id, i) => ({
    id,
    document: result.documents[0][i],
    metadata: result.metadatas[0][i],
    distance: result.distances[0][i],
  }));

const buildQueryInput = ({ embedding, text }) => {
  if ((embedding === undefined) === (text === undefined)) {
    throw new Error('vectorStore.query requires exactly one of embedding or text');
  }
  return embedding === undefined ? { queryTexts: [text] } : { queryEmbeddings: [embedding] };
};

export const createVectorStore = ({ client, embeddingFunction, config }) => {
  let pending = null;

  const loadCollections = async () => {
    const { chroma } = config;
    const messages = await client.getOrCreateCollection({
      name: chroma.messagesCollection, embeddingFunction,
    });
    const replies = await client.getOrCreateCollection({
      name: chroma.repliesCollection, embeddingFunction,
    });
    return { messages, replies };
  };

  // A rejected attempt is dropped so the next call retries.
  const attempt = async () => {
    try {
      return await loadCollections();
    } catch (error) {
      pending = null;
      throw error;
    }
  };

  const collections = () => {
    if (!pending) pending = attempt();
    return pending;
  };

  const connect = async () => {
    await client.heartbeat();
    await collections();
  };

  const embed = async (text) => {
    const [embedding] = await embeddingFunction.generate([text]);
    return embedding;
  };

  const hasEmbedding = (embedding) => Array.isArray(embedding) && embedding.length > 0;

  const loadParentEmbeddings = async (messagesCollection, withReference) => {
    const ids = Array.from(new Set(withReference.map((m) => m.reference)));
    const referenced = await messagesCollection.get({ ids, include: ['embeddings'] });
    const entries = referenced.ids.map((id, i) => [id, referenced.embeddings?.[i]]);
    return new Map(entries.filter(([, embedding]) => hasEmbedding(embedding)));
  };

  const upsertReplies = async (repliesCollection, rows, parents) => {
    if (rows.length === 0) return;
    await repliesCollection.upsert({
      ids: rows.map((m) => m.id),
      documents: rows.map((m) => m.content),
      metadatas: rows.map(buildMetadata),
      embeddings: rows.map((m) => parents.get(m.reference)),
    });
  };

  const named = async (name) => {
    const target = (await collections())[name];
    if (!target) throw new Error(`Unknown collection: ${name}`);
    return target;
  };

  // Stored rows as Chroma holds them, so a repair can pass them back unchanged.
  const getRecords = async (name, ids) => {
    if (ids.length === 0) return new Map();
    const found = await (await named(name)).get({ ids, include: ['documents', 'metadatas', 'embeddings'] });
    return new Map(found.ids.map((id, i) => [id, {
      document: found.documents?.[i],
      metadata: found.metadatas?.[i],
      embedding: found.embeddings?.[i],
    }]));
  };

  // Only for adding a missing metadata key: records carry the row's existing document and embedding.
  const fillMetadata = async (name, records) => {
    if (records.length === 0) return;
    await (await named(name)).upsert({
      ids: records.map((r) => r.id),
      documents: records.map((r) => r.document),
      metadatas: records.map((r) => r.metadata),
      embeddings: records.map((r) => r.embedding),
    });
  };

  const addReplyRows = async (rows) => {
    if (rows.length === 0) return;
    const { replies } = await collections();
    await replies.upsert({
      ids: rows.map((r) => r.message.id),
      documents: rows.map((r) => r.message.content),
      metadatas: rows.map((r) => buildMetadata(r.message)),
      embeddings: rows.map((r) => r.embedding),
    });
  };

  const upsertMessages = async (msgs) => {
    const { messages, replies } = await collections();
    await messages.upsert({
      ids: msgs.map((m) => m.id),
      documents: msgs.map((m) => m.content),
      metadatas: msgs.map(buildMetadata),
    });
    const withReference = msgs.filter((m) => m.reference);
    if (withReference.length === 0) return;
    const parents = await loadParentEmbeddings(messages, withReference);
    const qualifying = withReference.filter((m) => parents.has(m.reference));
    await upsertReplies(replies, qualifying, parents);
  };

  const getEmbeddings = async (ids) => {
    if (ids.length === 0) return new Map();
    const { messages } = await collections();
    const found = await messages.get({ ids, include: ['embeddings'] });
    const entries = found.ids.map((id, i) => [id, found.embeddings?.[i]]);
    return new Map(entries.filter(([, embedding]) => hasEmbedding(embedding)));
  };

  const query = async (name, { embedding, text, where, limit }) => {
    const input = buildQueryInput({ embedding, text });
    const target = await named(name);
    const result = await target.query({
      ...input, nResults: limit, where, include: QUERY_INCLUDE,
    });
    return toHits(result);
  };

  return {
    connect, embed, upsertMessages, query, getEmbeddings, getRecords, fillMetadata, addReplyRows,
  };
};
