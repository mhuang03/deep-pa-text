// SQL of the topic bank. Rows are only ever added; the deleted_at marker is the one thing that is updated.
export const INSERT_BUILD = `
  INSERT INTO topic_builds (build_id, completed_at, stats) VALUES (?, ?, ?)
  ON CONFLICT(build_id) DO NOTHING
`;
export const INSERT_TOPIC = `
  INSERT INTO topics (build_id, label, summary, size, author_count, cohesion, median_timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;
export const INSERT_AUTHOR = `
  INSERT INTO topic_authors (topic_id, author, share, newest_timestamp) VALUES (?, ?, ?, ?)
`;
export const INSERT_MESSAGE = 'INSERT INTO topic_messages (topic_id, message_id, rank) VALUES (?, ?, ?)';
export const CURRENT_BUILD = `
  SELECT build_id, completed_at FROM topic_builds ORDER BY completed_at DESC, build_id DESC LIMIT 1
`;
export const TOPICS_OF_BUILD = `
  SELECT id, label, summary, size, author_count, cohesion, median_timestamp FROM topics
  WHERE build_id = ? AND deleted_at IS NULL ORDER BY id
`;
export const AUTHORS_OF_BUILD = `
  SELECT a.topic_id, a.author, a.share, a.newest_timestamp FROM topic_authors a
  JOIN topics t ON t.id = a.topic_id
  WHERE t.build_id = ? AND t.deleted_at IS NULL ORDER BY a.topic_id, a.share DESC, a.author
`;
// A representative whose corpus row was deleted or replaced by an edit simply disappears.
export const SAMPLES_OF_TOPIC = `
  SELECT f.author, f.content FROM topic_messages m
  JOIN filtered_messages f ON f.id = m.message_id AND f.deleted_at IS NULL
  WHERE m.topic_id = ? ORDER BY m.rank LIMIT ?
`;
export const HIDE_TOPIC = 'UPDATE topics SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL';
export const HIDDEN_LABELS = 'SELECT label FROM topics WHERE deleted_at IS NOT NULL';
