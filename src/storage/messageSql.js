// SQL for the message store. A logical message is its Discord id; an edit adds a corpus row
// whose source_id is that id, so a logical id matches `id = ? OR source_id = ?`.
export const INSERT_RAW = `
  INSERT INTO messages (id, author, content, timestamp, reference)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
export const INSERT_FILTERED = `
  INSERT INTO filtered_messages (id, author, content, timestamp, reference, has_gif, source_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
export const INSERT_REVISION = `
  INSERT INTO message_revisions (message_id, content, edited_at)
  VALUES (?, ?, ?)
  ON CONFLICT(message_id, edited_at) DO NOTHING
`;
export const PREVIOUS_VISIBLE = `
  SELECT id, source_id, author, timestamp FROM filtered_messages
  WHERE timestamp < ? AND deleted_at IS NULL
  ORDER BY timestamp DESC
  LIMIT 1
`;
export const RAW_BY_ID = `
  SELECT id, author, content, timestamp, reference, deleted_at FROM messages WHERE id = ?
`;
export const HAS_RAW = 'SELECT 1 AS found FROM messages WHERE id = ?';
// Keyset pagination over visible corpus rows; the (timestamp, id) cursor is exclusive.
export const PAGE_FILTERED = `
  SELECT id, author, content, timestamp, reference, has_gif FROM filtered_messages
  WHERE deleted_at IS NULL
    AND (? IS NULL OR timestamp > ? OR (timestamp = ? AND id > ?))
  ORDER BY timestamp, id
  LIMIT ?
`;
export const NEWEST_REVISION = `
  SELECT content FROM message_revisions WHERE message_id = ? ORDER BY edited_at DESC LIMIT 1
`;
// The reference column must name an existing row (foreign key), and the logical message must be visible.
export const ANCHORED_VISIBLE = `
  SELECT 1 AS found FROM filtered_messages a
  WHERE a.id = ? AND EXISTS (
    SELECT 1 FROM filtered_messages v WHERE (v.id = a.id OR v.source_id = a.id) AND v.deleted_at IS NULL
  )
`;
export const ROW_EXISTS = 'SELECT 1 AS found FROM filtered_messages WHERE id = ?';
export const MARK_RAW_DELETED =
  'UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL';
export const MARK_CORPUS_DELETED = `
  UPDATE filtered_messages SET deleted_at = ?
  WHERE (id = ? OR source_id = ?) AND deleted_at IS NULL
`;
export const RANDOM_MESSAGES = `
  SELECT id, content FROM filtered_messages
  WHERE author = ? AND deleted_at IS NULL AND (? IS NULL OR timestamp < ?)
  ORDER BY RANDOM()
  LIMIT ?
`;
// The gap is measured on the raw table so messages the corpus filter dropped still count as activity;
// deleted rows are excluded inside the window so they are not neighbours either.
export const RANDOM_STARTERS = `
  SELECT f.content
  FROM (
    SELECT id, timestamp - LAG(timestamp) OVER (ORDER BY timestamp, id) AS gap
    FROM messages WHERE deleted_at IS NULL
  ) g
  JOIN filtered_messages f ON (f.id = g.id OR f.source_id = g.id) AND f.deleted_at IS NULL
  WHERE f.author = ? AND (g.gap IS NULL OR g.gap > ?)
  ORDER BY RANDOM() LIMIT ?
`;
// Measured on the raw table: the corpus filter drops the short messages bursts are made of.
export const BURST_STATS = `
  SELECT COUNT(*) AS samples, COALESCE(AVG(is_burst), 0) AS rate FROM (
    SELECT author,
           CASE WHEN LEAD(author) OVER w = author
                 AND LEAD(timestamp) OVER w - timestamp <= ?
                THEN 1.0 ELSE 0.0 END AS is_burst
    FROM messages WHERE deleted_at IS NULL
    WINDOW w AS (ORDER BY timestamp, id)
  ) WHERE author = ?
`;
export const LATEST_WITH_REFERENCE = `
  SELECT m.*, r.content as reference_content FROM filtered_messages m
  JOIN filtered_messages r ON (r.id = m.reference OR r.source_id = m.reference) AND r.deleted_at IS NULL
  WHERE m.deleted_at IS NULL
  ORDER BY m.timestamp DESC
  LIMIT ?
`;

const placeholders = (count) => Array(count).fill('?').join(', ');

export const countsSql = (count) => `
  SELECT content, COUNT(*) AS times FROM filtered_messages
  WHERE author = ? AND timestamp < ? AND deleted_at IS NULL AND content IN (${placeholders(count)})
  GROUP BY content
`;
export const parentsSql = (count) => `
  SELECT m.id AS id, r.content AS content FROM filtered_messages m
  JOIN filtered_messages r ON (r.id = m.reference OR r.source_id = m.reference) AND r.deleted_at IS NULL
  WHERE m.id IN (${placeholders(count)})
`;
export const hiddenSql = (count) => `
  SELECT id FROM filtered_messages WHERE deleted_at IS NOT NULL AND id IN (${placeholders(count)})
`;
export const latestFrom = (table, where) =>
  `SELECT * FROM ${table} WHERE ${where} ORDER BY timestamp DESC LIMIT ?`;
