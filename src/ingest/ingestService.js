export const createIngestService = ({ messageStore, vectorStore, messageFilter }) => {
  const recordMessage = async (record) => {
    messageStore.insertRaw(record);
    const filtered = messageFilter.filter(record);
    if (!filtered) return { filtered: null, stored: null };
    const stored = messageStore.insertFiltered(filtered);
    // A duplicate delivery must not re-resolve a reference or rewrite existing vectors.
    if (stored) await vectorStore.upsertMessages([stored]);
    return { filtered, stored };
  };

  return { recordMessage };
};
