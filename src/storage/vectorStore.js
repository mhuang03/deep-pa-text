import { createConfigError } from '../config/errors.js';
import { createVectorGuard } from './vectorGuard.js';
import { createCollectionLoader } from './vectorCollections.js';
import {
  QUERY_INCLUDE, hasEmbedding, dedupeById, toHits, buildQueryInput, toUpsertBody,
} from './vectorRecords.js';

export { collectionNames } from './vectorCollections.js';

export const createVectorStore = ({ client, embeddingFunction, config, generation = null, clock }) => {
  if (!clock) throw new Error('createVectorStore requires a clock');
  const guard = createVectorGuard({ config, clock });
  const { timed, limits } = guard;
  const { collections } = createCollectionLoader({ client, embeddingFunction, config, generation, guard });

  const readStoredDimension = async (messages) => {
    const found = await timed('peek', limits.connect, () => messages.get({ limit: 1, include: ['embeddings'] }));
    return found.embeddings?.[0]?.length ?? null;
  };

  // A model change with the same dimension cannot be seen without an embedding request.
  const assertDimensions = (stored) => {
    const expected = config.embedding.dimensions;
    if (stored === null || stored === expected) return;
    throw createConfigError(
      `The Chroma collection holds ${stored}-dimension embeddings but embedding.dimensions is ${expected}. `
      + 'Restore the original embedding settings, or start a new collection with a re-import.',
    );
  };

  const connect = async () => {
    await timed('connect', limits.connect, () => client.heartbeat());
    const { messages } = await collections(limits.connect);
    assertDimensions(await readStoredDimension(messages));
  };

  const embed = async (text) => {
    const [embedding] = await timed('embed', limits.interactive, () => embeddingFunction.generate([text]));
    return embedding;
  };

  const loadParentEmbeddings = async (messagesCollection, withReference, ms) => {
    const ids = Array.from(new Set(withReference.map((m) => m.reference)));
    const referenced = await timed('upsertMessages', ms, () => messagesCollection.get({ ids, include: ['embeddings'] }));
    const entries = referenced.ids.map((id, i) => [id, referenced.embeddings?.[i]]);
    return new Map(entries.filter(([, embedding]) => hasEmbedding(embedding)));
  };

  const upsertReplies = async (repliesCollection, rows, parents, ms) => {
    if (rows.length === 0) return;
    const body = { ...toUpsertBody(rows), embeddings: rows.map((m) => parents.get(m.reference)) };
    await timed('upsertMessages', ms, () => repliesCollection.upsert(body));
  };

  const named = async (name, ms) => {
    const target = (await collections(ms))[name];
    if (!target) throw new Error(`Unknown collection: ${name}`);
    return target;
  };

  // Stored rows as Chroma holds them, so a repair can pass them back unchanged.
  const getRecords = async (name, ids) => {
    if (ids.length === 0) return new Map();
    const target = await named(name, limits.batch);
    const found = await timed('getRecords', limits.batch, () => target.get({
      ids, include: ['documents', 'metadatas', 'embeddings'],
    }));
    return new Map(found.ids.map((id, i) => [id, {
      document: found.documents?.[i],
      metadata: found.metadatas?.[i],
      embedding: found.embeddings?.[i],
    }]));
  };

  // Only for adding a missing metadata key: records carry the row's existing document and embedding.
  const fillMetadata = async (name, input) => {
    const records = dedupeById(input, (r) => r.id);
    if (records.length === 0) return;
    const target = await named(name, limits.batch);
    await timed('fillMetadata', limits.batch, () => target.upsert({
      ids: records.map((r) => r.id),
      documents: records.map((r) => r.document),
      metadatas: records.map((r) => r.metadata),
      embeddings: records.map((r) => r.embedding),
    }));
  };

  const addReplyRows = async (input) => {
    const rows = dedupeById(input, (r) => r.message.id);
    if (rows.length === 0) return;
    const { replies } = await collections(limits.batch);
    await timed('addReplyRows', limits.batch, () => replies.upsert({
      ...toUpsertBody(rows.map((r) => r.message)),
      embeddings: rows.map((r) => r.embedding),
    }));
  };

  const upsertMessages = async (input) => {
    const msgs = dedupeById(input, (m) => m.id);
    if (msgs.length === 0) return;
    const ms = msgs.length > 1 ? limits.batch : limits.interactive;
    const { messages, replies } = await collections(ms);
    await timed('upsertMessages', ms, () => messages.upsert(toUpsertBody(msgs)));
    const withReference = msgs.filter((m) => m.reference);
    if (withReference.length === 0) return;
    const parents = await loadParentEmbeddings(messages, withReference, ms);
    await upsertReplies(replies, withReference.filter((m) => parents.has(m.reference)), parents, ms);
  };

  const getEmbeddings = async (ids) => {
    if (ids.length === 0) return new Map();
    const { messages } = await collections(limits.interactive);
    const found = await timed('getEmbeddings', limits.interactive, () => messages.get({ ids, include: ['embeddings'] }));
    const entries = found.ids.map((id, i) => [id, found.embeddings?.[i]]);
    return new Map(entries.filter(([, embedding]) => hasEmbedding(embedding)));
  };

  const query = async (name, { embedding, text, where, limit }) => {
    const input = buildQueryInput({ embedding, text });
    const target = await named(name, limits.interactive);
    const result = await timed('query', limits.interactive, () => target.query({
      ...input, nResults: limit, where, include: QUERY_INCLUDE,
    }));
    return toHits(result);
  };

  return {
    connect, embed, upsertMessages, query, getEmbeddings, getRecords, fillMetadata, addReplyRows,
  };
};
