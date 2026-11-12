const QUERY_INCLUDE = ['documents', 'metadatas', 'distances'];

const buildMetadata = (m) => ({ author: m.author, timestamp: m.timestamp, has_gif: m.hasGif });

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

  const loadParentEmbeddings = async (messagesCollection, withReference) => {
    const ids = Array.from(new Set(withReference.map((m) => m.reference)));
    const referenced = await messagesCollection.get({ ids, include: ['embeddings'] });
    if (referenced.ids.length === 0) return null;
    return new Map(referenced.ids.map((id, i) => [id, referenced.embeddings[i]]));
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
    if (!parents) return;
    // Legacy behaviour, pinned: every referencing message is upserted, even if its parent was not found.
    await replies.upsert({
      ids: withReference.map((m) => m.id),
      documents: withReference.map((m) => m.content),
      metadatas: withReference.map(buildMetadata),
      embeddings: withReference.map((m) => parents.get(m.reference)),
    });
  };

  const query = async (name, { embedding, text, where, limit }) => {
    const input = buildQueryInput({ embedding, text });
    const target = (await collections())[name];
    if (!target) throw new Error(`Unknown collection: ${name}`);
    const result = await target.query({
      ...input, nResults: limit, where, include: QUERY_INCLUDE,
    });
    return toHits(result);
  };

  return { connect, embed, upsertMessages, query };
};
