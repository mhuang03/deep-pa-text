const INSERT = `
  INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
const BY_ID = 'SELECT * FROM bot_messages WHERE id = ?';
const RECENT = 'SELECT * FROM bot_messages ORDER BY timestamp DESC, id DESC LIMIT ?';

const SIBLINGS = `
  SELECT * FROM bot_messages
  WHERE persona = ? AND trigger = ? AND reference IS ? AND ABS(timestamp - ?) <= ?
  ORDER BY timestamp, id
`;

const toBotMessage = (row) => (row ? { ...row } : null);

export const createBotMessageStore = ({ db, config }) => {
  const windowMs = config.burst.siblingWindowMs;
  const insertSql = db.prepare(INSERT);
  const byIdSql = db.prepare(BY_ID);
  const recentSql = db.prepare(RECENT);
  const siblingsSql = db.prepare(SIBLINGS);

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

  // The parts of one burst share persona, trigger and reference; the window keeps separate revives apart.
  const siblings = (botMessage) =>
    siblingsSql.all(
      botMessage.persona, botMessage.trigger, botMessage.reference ?? null, botMessage.timestamp, windowMs,
    ).map(toBotMessage);

  return { insert, getById, recent, siblings };
};
