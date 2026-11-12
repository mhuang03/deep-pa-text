const INSERT = `
  INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
const BY_ID = 'SELECT * FROM bot_messages WHERE id = ?';
const RECENT = `
  SELECT * FROM bot_messages WHERE deleted_at IS NULL ORDER BY timestamp DESC, id DESC LIMIT ?
`;
const MARK_DELETED = 'UPDATE bot_messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL';

const SIBLINGS = `
  SELECT * FROM bot_messages
  WHERE deleted_at IS NULL AND persona = ? AND trigger = ? AND reference IS ? AND ABS(timestamp - ?) <= ?
  ORDER BY timestamp, id
`;

const newestSql = (count) => `
  SELECT * FROM bot_messages
  WHERE deleted_at IS NULL AND trigger IN (${Array(count).fill('?').join(', ')})
  ORDER BY timestamp DESC, id DESC LIMIT 1
`;

// Invisible rows carry deleted: true; visible rows keep their original shape.
const toBotMessage = (row) => {
  if (!row) return null;
  const { deleted_at: deletedAt, ...rest } = row;
  return deletedAt === null || deletedAt === undefined ? rest : { ...rest, deleted: true };
};

export const createBotMessageStore = ({ db, config }) => {
  const windowMs = config.burst.siblingWindowMs;
  const insertSql = db.prepare(INSERT);
  const byIdSql = db.prepare(BY_ID);
  const recentSql = db.prepare(RECENT);
  const siblingsSql = db.prepare(SIBLINGS);
  const markDeletedSql = db.prepare(MARK_DELETED);

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

  // The newest visible row of any of the given triggers, or null.
  const newest = ({ triggers }) => {
    if (!Array.isArray(triggers) || triggers.length === 0) {
      throw new Error('newest: triggers must be a non-empty array');
    }
    return toBotMessage(db.prepare(newestSql(triggers.length)).get(...triggers));
  };

  const softDelete = (id, at) => Number(markDeletedSql.run(at, id).changes) > 0;

  return { insert, getById, recent, newest, siblings, softDelete };
};
