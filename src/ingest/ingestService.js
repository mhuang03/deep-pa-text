const noop = () => {};

export const createIngestService = ({
  messageStore, vectorStore, messageFilter, botMessageStore, onVectorError = noop,
}) => {
  // A reply to a bot message must not be linked to an unrelated human message.
  const prepare = (record, repliesToBot) => ({
    filtered: messageFilter.filter(record), inferReference: !repliesToBot,
  });

  const ingestEntry = ({ record, repliesToBot = false }) => {
    const inserted = messageStore.insertRaw(record);
    const { filtered, inferReference } = prepare(record, repliesToBot);
    const stored = filtered ? messageStore.insertFiltered(filtered, { inferReference }) : null;
    return { inserted, result: { filtered, stored } };
  };

  // Entries are chronological so reference resolution sees the earlier ones. The SQLite writes are one
  // atomic batch; a vector failure afterwards leaves them in place for the vector sync to repair.
  const writeEntries = (entries) => {
    const outcomes = messageStore.transaction(() => entries.map(ingestEntry));
    const results = outcomes.map((outcome) => outcome.result);
    const storedMessages = results.map((result) => result.stored).filter(Boolean);
    return { outcomes, results, storedMessages };
  };

  // Chroma rejects empty id lists, and a duplicate delivery must not rewrite existing vectors.
  const writeVectors = async (storedMessages) => {
    if (storedMessages.length > 0) await vectorStore.upsertMessages(storedMessages);
  };

  // Live handlers tolerate a vector failure: the SQLite rows are safe and the vector health repairs the rest.
  const writeVectorsTolerant = async (storedMessages, tolerate) => {
    try {
      await writeVectors(storedMessages);
      return false;
    } catch (error) {
      if (!tolerate || error?.isVectorError !== true) throw error;
      onVectorError(error);
      return true;
    }
  };

  const recordMessages = async (entries) => {
    const { outcomes, results, storedMessages } = writeEntries(entries);
    await writeVectors(storedMessages);
    return {
      results,
      insertedRaw: outcomes.filter((outcome) => outcome.inserted).length,
      kept: storedMessages.length,
    };
  };

  const recordMessage = async (record, { repliesToBot = false, tolerateVectorErrors = false } = {}) => {
    const { results, storedMessages } = writeEntries([{ record, repliesToBot }]);
    const vectorFailed = await writeVectorsTolerant(storedMessages, tolerateVectorErrors);
    return { ...results[0], vectorFailed };
  };

  // Discord also emits updates for link previews and pins, so unchanged content is not an edit.
  const recordEdit = async (record, { repliesToBot = false, tolerateVectorErrors = false } = {}) => {
    const { editedAt, ...message } = record;
    const raw = messageStore.getRaw(message.id);
    if (!raw) {
      const { vectorFailed } = await recordMessage(message, { repliesToBot, tolerateVectorErrors });
      return { changed: true, vectorFailed };
    }
    if (raw.deleted || message.content === raw.content) return { changed: false, vectorFailed: false };
    const stored = messageStore.applyEdit({
      id: message.id, content: message.content, editedAt, ...prepare(message, repliesToBot),
    });
    const vectorFailed = await writeVectorsTolerant(stored ? [stored] : [], tolerateVectorErrors);
    return { changed: true, vectorFailed };
  };

  const recordDelete = (id, at) => {
    messageStore.softDelete(id, at);
    botMessageStore.softDelete(id, at);
  };

  return { recordMessage, recordMessages, recordEdit, recordDelete };
};
