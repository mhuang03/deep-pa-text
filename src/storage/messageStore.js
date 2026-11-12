const INSERT_RAW = `
  INSERT INTO messages (id, author, content, timestamp, reference)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
const INSERT_FILTERED = `
  INSERT INTO filtered_messages (id, author, content, timestamp, reference, has_gif)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;
const PREVIOUS_FILTERED = `
  SELECT * FROM filtered_messages
  WHERE timestamp < ?
  ORDER BY timestamp DESC
  LIMIT 1
`;
const RAW_BY_ID = 'SELECT id, author, content, timestamp, reference FROM messages WHERE id = ?';
const FILTERED_EXISTS = 'SELECT 1 as id_exists FROM filtered_messages WHERE id = ?';
const RANDOM_MESSAGES = `
  SELECT id, content FROM filtered_messages
  WHERE author = ? AND (? IS NULL OR timestamp < ?)
  ORDER BY RANDOM()
  LIMIT ?
`;
// The gap is measured on the raw table so messages the corpus filter dropped still count as activity.
const RANDOM_STARTERS = `
  SELECT f.content
  FROM (
    SELECT id, timestamp - LAG(timestamp) OVER (ORDER BY timestamp, id) AS gap
    FROM messages
  ) g
  JOIN filtered_messages f ON f.id = g.id
  WHERE f.author = ? AND (g.gap IS NULL OR g.gap > ?)
  ORDER BY RANDOM() LIMIT ?
`;
const LATEST_WITH_REFERENCE = `
  SELECT m.*, r.content as reference_content FROM filtered_messages m
  JOIN filtered_messages r ON m.reference = r.id
  ORDER BY m.timestamp DESC
  LIMIT ?
`;
const CHUNK_SIZE = 500;
const countsSql = (count) => `
  SELECT content, COUNT(*) AS times FROM filtered_messages
  WHERE author = ? AND timestamp < ? AND content IN (${Array(count).fill('?').join(', ')})
  GROUP BY content
`;
const parentsSql = (count) => `
  SELECT m.id AS id, r.content AS content FROM filtered_messages m
  JOIN filtered_messages r ON m.reference = r.id
  WHERE m.id IN (${Array(count).fill('?').join(', ')})
`;
const latestFrom = (table, where = '') =>
  `SELECT * FROM ${table} ${where} ORDER BY timestamp DESC LIMIT ?`;

const GIF_TOKEN = '<gif!';

export const createMessageStore = ({ db, config }) => {
  const windowMs = config.storage.inferredReferenceWindowMs;
  const insertRawSql = db.prepare(INSERT_RAW);
  const insertFilteredSql = db.prepare(INSERT_FILTERED);
  const previousSql = db.prepare(PREVIOUS_FILTERED);
  const rawByIdSql = db.prepare(RAW_BY_ID);
  const existsSql = db.prepare(FILTERED_EXISTS);
  const randomSql = db.prepare(RANDOM_MESSAGES);
  const startersSql = db.prepare(RANDOM_STARTERS);
  const latestRawSql = db.prepare(latestFrom('messages'));
  const latestFilteredSql = db.prepare(latestFrom('filtered_messages'));
  const latestGifSql = db.prepare(latestFrom('filtered_messages', 'WHERE has_gif = 1'));
  const latestRefSql = db.prepare(LATEST_WITH_REFERENCE);

  const resolveExplicit = (reference) =>
    reference && existsSql.get(reference) ? reference : null;

  const inferReference = (record) => {
    const previous = previousSql.get(record.timestamp);
    if (!previous || previous.author === record.author) return null;
    return record.timestamp - previous.timestamp < windowMs ? previous.id : null;
  };

  const resolveReference = (record, shouldInfer) =>
    resolveExplicit(record.reference) ?? (shouldInfer ? inferReference(record) : null);

  const insertRaw = (record) => {
    insertRawSql.run(
      record.id, record.author, record.content, record.timestamp, record.reference ?? null,
    );
  };

  // Replies to bot messages pass inferReference: false so they are not linked to an unrelated human message.
  const insertFiltered = (record, { inferReference: shouldInfer = true } = {}) => {
    const hasGif = record.content.includes(GIF_TOKEN);
    const reference = resolveReference(record, shouldInfer);
    const { changes } = insertFilteredSql.run(
      record.id, record.author, record.content, record.timestamp, reference, hasGif ? 1 : 0,
    );
    // A duplicate id inserts nothing; callers must not treat it as a new message.
    if (Number(changes) === 0) return null;
    return { ...record, reference, hasGif };
  };

  const randomMessages = ({ author, before = null, limit }) =>
    randomSql.all(author, before, before, limit).map((row) => ({ id: row.id, content: row.content }));

  const randomStarters = ({ author, minGapMs, limit }) =>
    startersSql.all(author, minGapMs, limit).map((row) => row.content);

  const chunksOf = (items) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      chunks.push(items.slice(i, i + CHUNK_SIZE));
    }
    return chunks;
  };

  // Ids whose reference does not resolve to a stored message are simply absent.
  const getParents = (ids) => {
    const parents = new Map();
    chunksOf(ids).forEach((chunk) => {
      db.prepare(parentsSql(chunk.length)).all(...chunk)
        .forEach((row) => parents.set(row.id, { content: row.content }));
    });
    return parents;
  };

  // Exact-content counts; contents never sent before the cutoff are absent from the map.
  const countContents = ({ author, contents, before }) => {
    const counts = new Map();
    chunksOf(Array.from(new Set(contents))).forEach((chunk) => {
      db.prepare(countsSql(chunk.length)).all(author, before, ...chunk)
        .forEach((row) => counts.set(row.content, row.times));
    });
    return counts;
  };

  const getRaw = (id) => {
    const row = rawByIdSql.get(id);
    return row ? { ...row } : null;
  };

  return {
    insertRaw,
    getRaw,
    countContents,
    getParents,
    insertFiltered,
    randomMessages,
    randomStarters,
    latestRaw: (limit) => latestRawSql.all(limit),
    latestFiltered: (limit) => latestFilteredSql.all(limit),
    latestWithReference: (limit) => latestRefSql.all(limit),
    latestWithGif: (limit) => latestGifSql.all(limit),
  };
};
