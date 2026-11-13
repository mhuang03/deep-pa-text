// Read-only queries for `npm run inspect`. The statements are chosen from the columns that exist,
// so a database from any earlier version can be read in place; nothing here writes or migrates.
const VISIBLE = 'deleted_at IS NULL';

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

const missing = (table) => ({ missing: table });

const visibleWhere = (columns, extra = '') => {
  const parts = [extra, columns.includes('deleted_at') ? VISIBLE : ''].filter(Boolean);
  return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
};

const latestSql = (table, where, order = 'timestamp DESC') =>
  `SELECT * FROM ${table} ${where} ORDER BY ${order} LIMIT ?`;

const REFERENCE_VISIBLE = ' AND r.deleted_at IS NULL';

const referenceSql = (columns) => {
  const hasSource = columns.includes('source_id');
  const hasDeleted = columns.includes('deleted_at');
  const join = hasSource ? '(r.id = m.reference OR r.source_id = m.reference)' : 'r.id = m.reference';
  const where = hasDeleted ? 'WHERE m.deleted_at IS NULL' : '';
  return `
  SELECT m.*, r.content as reference_content FROM filtered_messages m
  JOIN filtered_messages r ON ${join}${hasDeleted ? REFERENCE_VISIBLE : ''}
  ${where}
  ORDER BY m.timestamp DESC
  LIMIT ?
`;
};

const toBotRow = (row) => ({ ...row, author: `${row.persona} [${row.trigger}]` });

// Delivered turns are the distinct turn indexes of a conversation's visible bot messages.
const deliveredSql = (botColumns) => {
  if (!botColumns.includes('conversation_id') || !botColumns.includes('turn_index')) return '0';
  const visible = botColumns.includes('deleted_at') ? ` AND b.${VISIBLE}` : '';
  return `(SELECT COUNT(DISTINCT b.turn_index) FROM bot_messages b WHERE b.conversation_id = c.id${visible})`;
};

const toConversationRow = (row) => ({
  id: row.id,
  timestamp: row.started_at,
  topic: row.topic,
  personas: JSON.parse(row.personas),
  planned: JSON.parse(row.turns).length,
  delivered: row.delivered,
});

export const createInspector = ({ db }) => {
  const query = (table, build, map = (row) => row) => (limit) => {
    const columns = columnsOf(db, table);
    if (columns.length === 0) return missing(table);
    return { rows: db.prepare(build(columns)).all(limit).map(map) };
  };

  const gifWhere = (columns) =>
    visibleWhere(columns, columns.includes('has_gif') ? 'has_gif = 1' : "content LIKE '%<gif!%'");

  return {
    latestRaw: query('messages', (c) => latestSql('messages', visibleWhere(c))),
    latestFiltered: query('filtered_messages', (c) => latestSql('filtered_messages', visibleWhere(c))),
    latestWithReference: query('filtered_messages', referenceSql),
    latestWithGif: query('filtered_messages', (c) => latestSql('filtered_messages', gifWhere(c))),
    latestConversations: (limit) => {
      if (columnsOf(db, 'conversations').length === 0) return missing('conversations');
      const sql = `SELECT c.*, ${deliveredSql(columnsOf(db, 'bot_messages'))} AS delivered
        FROM conversations c ORDER BY c.started_at DESC, c.id DESC LIMIT ?`;
      return { rows: db.prepare(sql).all(limit).map(toConversationRow) };
    },
    latestBot: query('bot_messages', (c) => latestSql('bot_messages', visibleWhere(c), 'timestamp DESC, id DESC'), toBotRow),
  };
};
