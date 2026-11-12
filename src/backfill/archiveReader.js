// Reads a previous database through a handle that is never written to. Older schemas lack tables,
// so each read checks sqlite_master first.
const TABLE_QUERY = "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?";

export const createArchiveReader = ({ db }) => {
  const hasTable = (name) => db.prepare(TABLE_QUERY).get(name) !== undefined;

  const rows = (table, sql, ...params) => (hasTable(table) ? db.prepare(sql).all(...params) : []);

  const count = (table) => (hasTable(table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) : 0);

  const botMessage = (id) => {
    const [row] = rows('bot_messages', 'SELECT persona, content, reference, trigger FROM bot_messages WHERE id = ?', id);
    if (!row) return null;
    return { persona: row.persona, content: row.content, reference: row.reference ?? null, trigger: row.trigger };
  };

  const profiles = () => rows('user_profiles', 'SELECT * FROM user_profiles ORDER BY observed_at, username');

  const counts = () => ({ raw: count('messages'), corpus: count('filtered_messages'), botMessages: count('bot_messages') });

  const rawPage = ({ afterId = null, limit }) =>
    rows('messages', 'SELECT id, content FROM messages WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT ?', afterId, afterId, limit)
      .map((row) => ({ id: row.id, content: row.content }));

  return { botMessage, profiles, counts, rawPage };
};
