import { markVectorError } from '../util/vectorError.js';

export const createIngestService = ({ messageStore, vectorStore, messageFilter, botMessageStore }) => {
  // A reply to a bot message must not be linked to an unrelated human message.
  const prepare = (record, repliesToBot) => ({
    filtered: messageFilter.filter(record), inferReference: !repliesToBot,
  });

  const upsertVectors = async (storedMessages) => {
    try {
      await vectorStore.upsertMessages(storedMessages);
    } catch (error) {
      throw markVectorError(error);
    }
  };

  const ingestEntry = ({ record, repliesToBot = false }) => {
    const inserted = messageStore.insertRaw(record);
    const { filtered, inferReference } = prepare(record, repliesToBot);
    const stored = filtered ? messageStore.insertFiltered(filtered, { inferReference }) : null;
    return { inserted, result: { filtered, stored } };
  };

  // Entries are chronological so reference resolution sees the earlier ones. The SQLite writes are one
  // atomic batch; a vector failure afterwards leaves them in place for the vector sync to repair.
  const recordMessages = async (entries) => {
    const outcomes = messageStore.transaction(() => entries.map(ingestEntry));
    const results = outcomes.map((outcome) => outcome.result);
    const storedMessages = results.map((result) => result.stored).filter(Boolean);
    // Chroma rejects empty id lists, and a duplicate delivery must not rewrite existing vectors.
    if (storedMessages.length > 0) await upsertVectors(storedMessages);
    return {
      results,
      insertedRaw: outcomes.filter((outcome) => outcome.inserted).length,
      kept: storedMessages.length,
    };
  };

  const recordMessage = async (record, options = {}) =>
    (await recordMessages([{ record, ...options }])).results[0];

  // Discord also emits updates for link previews and pins, so unchanged content is not an edit.
  const recordEdit = async (record, { repliesToBot = false } = {}) => {
    const { editedAt, ...message } = record;
    const raw = messageStore.getRaw(message.id);
    if (!raw) {
      await recordMessage(message, { repliesToBot });
      return { changed: true };
    }
    if (raw.deleted || message.content === raw.content) return { changed: false };
    const stored = messageStore.applyEdit({
      id: message.id, content: message.content, editedAt, ...prepare(message, repliesToBot),
    });
    if (stored) await vectorStore.upsertMessages([stored]);
    return { changed: true };
  };

  const recordDelete = (id, at) => {
    messageStore.softDelete(id, at);
    botMessageStore.softDelete(id, at);
  };

  return { recordMessage, recordMessages, recordEdit, recordDelete };
};
