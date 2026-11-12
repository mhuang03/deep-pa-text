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
    latestBot: query('bot_messages', (c) => latestSql('bot_messages', visibleWhere(c), 'timestamp DESC, id DESC'), toBotRow),
  };
};
