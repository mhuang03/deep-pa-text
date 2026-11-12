const pickIndex = (roll, length) => Math.floor(roll * length);

export const createPersonaSelector = ({ vectorStore, users, random, config }) => {
  const likelyRepliers = async (record) => {
    const hits = await vectorStore.query('replies', {
      text: record.content,
      where: {
        $and: [{ author: { $ne: record.author } }, { timestamp: { $lt: record.timestamp } }],
      },
      limit: config.retrieval.likelyRepliers,
    });
    return hits.map((hit) => hit.metadata.author);
  };

  const pickRandomUser = () => users[pickIndex(random(), users.length)].username;

  const pickReplier = async (record) => {
    const list = await likelyRepliers(record);
    // The roll is consumed even when the list is empty (pinned Math.random order).
    const chosen = list[pickIndex(random(), list.length)];
    return chosen === undefined ? pickRandomUser() : chosen;
  };

  return { likelyRepliers, pickReplier, pickRandomUser };
};
