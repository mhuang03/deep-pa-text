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
const FILTERED_EXISTS = 'SELECT 1 as id_exists FROM filtered_messages WHERE id = ?';
const RANDOM_CONTENTS = `
  SELECT content FROM filtered_messages
  WHERE author = ? AND (? IS NULL OR timestamp < ?)
  ORDER BY RANDOM()
  LIMIT ?
`;
const LATEST_WITH_REFERENCE = `
  SELECT m.*, r.content as reference_content FROM filtered_messages m
  JOIN filtered_messages r ON m.reference = r.id
  ORDER BY m.timestamp DESC
  LIMIT ?
`;
const PARENT_CHUNK_SIZE = 500;
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
  const existsSql = db.prepare(FILTERED_EXISTS);
  const randomSql = db.prepare(RANDOM_CONTENTS);
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

  const resolveReference = (record) =>
    resolveExplicit(record.reference) ?? inferReference(record);

  const insertRaw = (record) => {
    insertRawSql.run(
      record.id, record.author, record.content, record.timestamp, record.reference ?? null,
    );
  };

  const insertFiltered = (record) => {
    const hasGif = record.content.includes(GIF_TOKEN);
    const reference = resolveReference(record);
    const { changes } = insertFilteredSql.run(
      record.id, record.author, record.content, record.timestamp, reference, hasGif ? 1 : 0,
    );
    // A duplicate id inserts nothing; callers must not treat it as a new message.
    if (Number(changes) === 0) return null;
    return { ...record, reference, hasGif };
  };

  const randomContents = ({ author, before = null, limit }) =>
    randomSql.all(author, before, before, limit).map((row) => row.content);

  const chunksOf = (items) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += PARENT_CHUNK_SIZE) {
      chunks.push(items.slice(i, i + PARENT_CHUNK_SIZE));
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

  return {
    insertRaw,
    getParents,
    insertFiltered,
    randomContents,
    latestRaw: (limit) => latestRawSql.all(limit),
    latestFiltered: (limit) => latestFilteredSql.all(limit),
    latestWithReference: (limit) => latestRefSql.all(limit),
    latestWithGif: (limit) => latestGifSql.all(limit),
  };
};
