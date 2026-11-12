export const createIngestService = ({ messageStore, vectorStore, messageFilter }) => {
  const recordMessage = async (record) => {
    messageStore.insertRaw(record);
    const filtered = messageFilter.filter(record);
    if (filtered) {
      messageStore.insertFiltered(filtered);
      // Pinned legacy bug (spec 10): the filter output, not the stored message, goes to the
      // vector store, so it carries the raw reference and no hasGif.
      await vectorStore.upsertMessages([filtered]);
    }
    return { filtered };
  };

  return { recordMessage };
};
