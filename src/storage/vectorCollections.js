// A database that names a generation (a full re-import) owns its own pair of collections.
export const collectionNames = (config, generation) => {
  const { messagesCollection, repliesCollection } = config.chroma;
  if (!generation) return { messages: messagesCollection, replies: repliesCollection };
  return { messages: `${messagesCollection}_${generation}`, replies: `${repliesCollection}_${generation}` };
};

// The collections are looked up once and the promise is shared. It is dropped when it rejects or
// times out, as long as it is still the cached one, so the next call retries.
export const createCollectionLoader = ({ client, embeddingFunction, config, generation, guard }) => {
  let pending = null;

  const load = async () => {
    const names = collectionNames(config, generation);
    const messages = await client.getOrCreateCollection({ name: names.messages, embeddingFunction });
    const replies = await client.getOrCreateCollection({ name: names.replies, embeddingFunction });
    return { messages, replies };
  };

  const collections = (ms) => {
    if (pending) return pending;
    const current = guard.timed('getOrCreateCollection', ms, load);
    pending = current;
    current.catch(() => {
      if (pending === current) pending = null;
    });
    return current;
  };

  return { collections };
};
