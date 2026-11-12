const noop = () => {};

// A reply to a bot message must not be linked to an unrelated human message.
const ingestEntry = ({ messageStore, messageFilter }, { record, repliesToBot = false }) => {
  const inserted = messageStore.insertRaw(record);
  const filtered = messageFilter.filter(record);
  const stored = filtered ? messageStore.insertFiltered(filtered, { inferReference: !repliesToBot }) : null;
  return { inserted, result: { filtered, stored } };
};

// Entries are chronological so reference resolution sees the earlier ones. The SQLite writes are one
// atomic batch; a vector failure afterwards leaves them in place for the vector sync to repair.
const writeEntries = (ctx, entries) => {
  const outcomes = ctx.messageStore.transaction(() => entries.map((entry) => ingestEntry(ctx, entry)));
  const results = outcomes.map((outcome) => outcome.result);
  const storedMessages = results.map((result) => result.stored).filter(Boolean);
  return { outcomes, results, storedMessages };
};

// Chroma rejects empty id lists, and a duplicate delivery must not rewrite existing vectors.
const writeVectors = async ({ vectorStore }, storedMessages) => {
  if (storedMessages.length > 0) await vectorStore.upsertMessages(storedMessages);
};

// Live handlers tolerate a vector failure: the SQLite rows are safe and the vector health repairs the rest.
const writeVectorsTolerant = async (ctx, storedMessages, tolerate) => {
  try {
    await writeVectors(ctx, storedMessages);
    return false;
  } catch (error) {
    if (!tolerate || error?.isVectorError !== true) throw error;
    ctx.onVectorError(error);
    return true;
  }
};

const recordMessages = async (ctx, entries) => {
  const { outcomes, results, storedMessages } = writeEntries(ctx, entries);
  await writeVectors(ctx, storedMessages);
  return {
    results,
    insertedRaw: outcomes.filter((outcome) => outcome.inserted).length,
    kept: storedMessages.length,
  };
};

const recordMessage = async (ctx, record, { repliesToBot = false, tolerateVectorErrors = false } = {}) => {
  const { results, storedMessages } = writeEntries(ctx, [{ record, repliesToBot }]);
  const vectorFailed = await writeVectorsTolerant(ctx, storedMessages, tolerateVectorErrors);
  return { ...results[0], vectorFailed };
};

// Discord also emits updates for link previews and pins, so unchanged content is not an edit.
// An edit never infers a reference (see messageStore.applyEdit), so it needs no bot-parent lookup.
const recordEdit = async (ctx, record, { tolerateVectorErrors = false } = {}) => {
  const { editedAt, ...message } = record;
  const raw = ctx.messageStore.getRaw(message.id);
  if (!raw) {
    const { vectorFailed } = await recordMessage(ctx, message, { repliesToBot: true, tolerateVectorErrors });
    return { changed: true, vectorFailed };
  }
  if (raw.deleted || message.content === raw.content) return { changed: false, vectorFailed: false };
  const stored = ctx.messageStore.applyEdit({
    id: message.id, content: message.content, editedAt, filtered: ctx.messageFilter.filter(message),
  });
  const vectorFailed = await writeVectorsTolerant(ctx, stored ? [stored] : [], tolerateVectorErrors);
  return { changed: true, vectorFailed };
};

export const createIngestService = ({
  messageStore, vectorStore, messageFilter, botMessageStore, onVectorError = noop,
}) => {
  const ctx = { messageStore, vectorStore, messageFilter, onVectorError };
  return {
    recordMessage: (record, options) => recordMessage(ctx, record, options),
    recordMessages: (entries) => recordMessages(ctx, entries),
    recordEdit: (record, options) => recordEdit(ctx, record, options),
    recordDelete: (id, at) => {
      messageStore.softDelete(id, at);
      botMessageStore.softDelete(id, at);
    },
  };
};
