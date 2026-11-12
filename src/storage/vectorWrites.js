import { namedCollection } from './vectorCollections.js';
import { hasEmbedding, dedupeById, toUpsertBody } from './vectorRecords.js';

const loadParentEmbeddings = async (timed, messagesCollection, { withReference, ms }) => {
  const ids = Array.from(new Set(withReference.map((m) => m.reference)));
  const referenced = await timed('upsertMessages', ms, () => messagesCollection.get({ ids, include: ['embeddings'] }));
  const entries = referenced.ids.map((id, i) => [id, referenced.embeddings?.[i]]);
  return new Map(entries.filter(([, embedding]) => hasEmbedding(embedding)));
};

const upsertReplies = async (timed, repliesCollection, { rows, parents, ms }) => {
  if (rows.length === 0) return;
  const body = { ...toUpsertBody(rows), embeddings: rows.map((m) => parents.get(m.reference)) };
  await timed('upsertMessages', ms, () => repliesCollection.upsert(body));
};

const upsertMessages = async ({ guard, collections }, input) => {
  const { timed, limits } = guard;
  const msgs = dedupeById(input, (m) => m.id);
  if (msgs.length === 0) return;
  const ms = msgs.length > 1 ? limits.batch : limits.interactive;
  const { messages, replies } = await collections(ms);
  await timed('upsertMessages', ms, () => messages.upsert(toUpsertBody(msgs)));
  const withReference = msgs.filter((m) => m.reference);
  if (withReference.length === 0) return;
  const parents = await loadParentEmbeddings(timed, messages, { withReference, ms });
  await upsertReplies(timed, replies, {
    rows: withReference.filter((m) => parents.has(m.reference)), parents, ms,
  });
};

// Only for adding a missing metadata key: records carry the row's existing document and embedding.
const fillMetadata = async ({ guard, collections }, name, input) => {
  const { timed, limits } = guard;
  const records = dedupeById(input, (r) => r.id);
  if (records.length === 0) return;
  const target = await namedCollection(collections, name, limits.batch);
  await timed('fillMetadata', limits.batch, () => target.upsert({
    ids: records.map((r) => r.id),
    documents: records.map((r) => r.document),
    metadatas: records.map((r) => r.metadata),
    embeddings: records.map((r) => r.embedding),
  }));
};

const addReplyRows = async ({ guard, collections }, input) => {
  const { timed, limits } = guard;
  const rows = dedupeById(input, (r) => r.message.id);
  if (rows.length === 0) return;
  const { replies } = await collections(limits.batch);
  await timed('addReplyRows', limits.batch, () => replies.upsert({
    ...toUpsertBody(rows.map((r) => r.message)),
    embeddings: rows.map((r) => r.embedding),
  }));
};

export const createVectorWrites = ({ guard, collections }) => {
  const ctx = { guard, collections };
  return {
    upsertMessages: (messages) => upsertMessages(ctx, messages),
    fillMetadata: (name, records) => fillMetadata(ctx, name, records),
    addReplyRows: (rows) => addReplyRows(ctx, rows),
  };
};
