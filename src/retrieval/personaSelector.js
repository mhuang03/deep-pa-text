import { pickWeighted, weighAuthors } from './personaWeights.js';

const pickIndex = (roll, length) => Math.floor(roll * length);

export const createPersonaSelector = ({ vectorStore, messageStore, users, random, config }) => {
  const likelyReplierHits = async (record) => {
    const hits = await vectorStore.query('replies', {
      text: record.content,
      where: {
        $and: [{ author: { $ne: record.author } }, { timestamp: { $lt: record.timestamp } }],
      },
      limit: config.retrieval.likelyRepliers * config.retrieval.overFetchFactor,
    });
    const hidden = messageStore.hiddenIds(hits.map((hit) => hit.id));
    return hits.filter((hit) => !hidden.has(hit.id)).slice(0, config.retrieval.likelyRepliers);
  };

  const likelyRepliers = async (record) =>
    (await likelyReplierHits(record)).map((hit) => hit.metadata.author);

  const pickRandomUser = ({ exclude } = {}) => {
    const others = users.filter((user) => user.username !== exclude);
    const pool = others.length > 0 ? others : users;
    return pool[pickIndex(random(), pool.length)].username;
  };

  const weighHits = (hits, record) => weighAuthors(hits, {
    referenceTimeMs: record.timestamp,
    halfLifeMs: config.persona.recencyHalfLifeMs,
    minRecency: config.persona.minRecencyWeight,
    allowedAuthors: users.map((user) => user.username),
  });

  const pickReplier = async (record) => {
    const hits = await likelyReplierHits(record);
    // The roll is consumed even when there are no hits (pinned Math.random order).
    const chosen = pickWeighted(weighHits(hits, record), random());
    return chosen === undefined ? pickRandomUser({ exclude: record.author }) : chosen;
  };

  return { likelyRepliers, likelyReplierHits, pickReplier, pickRandomUser };
};
