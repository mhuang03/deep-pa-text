// Random samples of the corpus for the topic bank. Only visible rows, never an edit's replaced row.
const COLUMNS = 'id, author, content, timestamp';

export const TOPIC_SAMPLE_RECENT = `
  SELECT ${COLUMNS} FROM filtered_messages
  WHERE deleted_at IS NULL AND LENGTH(content) >= ? AND timestamp >= ?
  ORDER BY RANDOM() LIMIT ?
`;
export const TOPIC_SAMPLE_OLDER = `
  SELECT ${COLUMNS} FROM filtered_messages
  WHERE deleted_at IS NULL AND LENGTH(content) >= ? AND timestamp < ?
  ORDER BY RANDOM() LIMIT ?
`;
export const RANDOM_CORPUS = `
  SELECT ${COLUMNS} FROM filtered_messages
  WHERE deleted_at IS NULL AND LENGTH(content) >= ?
  ORDER BY RANDOM() LIMIT ?
`;
