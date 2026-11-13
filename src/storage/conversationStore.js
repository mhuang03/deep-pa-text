const INSERT = `
  INSERT INTO conversations (id, started_at, topic_id, topic, premise, personas, turns)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
const BY_ID = 'SELECT * FROM conversations WHERE id = ?';
const RECENT = 'SELECT * FROM conversations ORDER BY started_at DESC, id DESC LIMIT ?';

const toSummary = (row) => ({ id: row.id, startedAt: row.started_at, topicId: row.topic_id, topic: row.topic });

const toConversation = (row) => (row ? {
  ...toSummary(row),
  premise: row.premise,
  personas: JSON.parse(row.personas),
  turns: JSON.parse(row.turns),
} : null);

// Append-only record of planned conversations; what was actually sent lives in bot_messages.
export const createConversationStore = ({ db }) => {
  const insertSql = db.prepare(INSERT);
  const byIdSql = db.prepare(BY_ID);
  const recentSql = db.prepare(RECENT);

  const insert = (plan, startedAt) => {
    insertSql.run(
      plan.id, startedAt, plan.topicId ?? null, plan.topic, plan.premise,
      JSON.stringify(plan.personas), JSON.stringify(plan.turns),
    );
  };

  const recent = ({ limit }) => {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`recent: limit is required and must be a non-negative integer, got ${limit}`);
    }
    return recentSql.all(limit).map(toSummary);
  };

  return { insert, recent, getById: (id) => toConversation(byIdSql.get(id)) };
};
