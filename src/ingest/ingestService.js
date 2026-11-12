export const createIngestService = ({ messageStore, vectorStore, messageFilter, botMessageStore }) => {
  // A reply to a bot message must not be linked to an unrelated human message.
  const prepare = (record, repliesToBot) => ({
    filtered: messageFilter.filter(record), inferReference: !repliesToBot,
  });

  const recordMessage = async (record, { repliesToBot = false } = {}) => {
    messageStore.insertRaw(record);
    const { filtered, inferReference } = prepare(record, repliesToBot);
    if (!filtered) return { filtered: null, stored: null };
    const stored = messageStore.insertFiltered(filtered, { inferReference });
    // A duplicate delivery must not re-resolve a reference or rewrite existing vectors.
    if (stored) await vectorStore.upsertMessages([stored]);
    return { filtered, stored };
  };

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

  return { recordMessage, recordEdit, recordDelete };
};
