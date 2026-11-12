const INSERT = `
  INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
const BY_ID = 'SELECT * FROM bot_messages WHERE id = ?';
const RECENT = 'SELECT * FROM bot_messages ORDER BY timestamp DESC, id DESC LIMIT ?';

const toBotMessage = (row) => (row ? { ...row } : null);

export const createBotMessageStore = ({ db }) => {
  const insertSql = db.prepare(INSERT);
  const byIdSql = db.prepare(BY_ID);
  const recentSql = db.prepare(RECENT);

  const insert = ({ id, persona, content, timestamp, reference = null, trigger }) => {
    insertSql.run(id, persona, content, timestamp, reference ?? null, trigger);
  };

  const getById = (id) => toBotMessage(byIdSql.get(id));

  const recent = ({ limit }) => {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`recent: limit is required and must be a non-negative integer, got ${limit}`);
    }
    return recentSql.all(limit).map(toBotMessage);
  };

  return { insert, getById, recent };
};
