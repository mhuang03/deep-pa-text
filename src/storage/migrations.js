// Ordered, additive, idempotent schema steps. The three statements below are the legacy
// schema verbatim; later specs append descriptors, never edit or reorder these.
export const MIGRATIONS = [
  {
    sql: `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reference TEXT
  )
`,
  },
  {
    sql: `
  CREATE TABLE IF NOT EXISTS filtered_messages (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reference TEXT,
    has_gif BOOLEAN NOT NULL,

    CONSTRAINT fk_reference FOREIGN KEY (reference) REFERENCES filtered_messages(id) ON DELETE SET NULL
  )
`,
  },
  {
    sql: `
  CREATE INDEX IF NOT EXISTS idx_filtered_messages_timestamp ON filtered_messages (timestamp)
`,
  },
  {
    sql: `
  CREATE TABLE IF NOT EXISTS bot_messages (
    id TEXT PRIMARY KEY,
    persona TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reference TEXT,
    trigger TEXT NOT NULL
  )
`,
  },
  {
    sql: `
  CREATE INDEX IF NOT EXISTS idx_bot_messages_timestamp ON bot_messages (timestamp)
`,
  },
  {
    sql: `
  CREATE INDEX IF NOT EXISTS idx_filtered_messages_author_content ON filtered_messages (author, content)
`,
  },
  {
    sql: `
  CREATE TABLE IF NOT EXISTS user_profiles (
    username TEXT NOT NULL,
    user_id TEXT,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (username, observed_at)
  )
`,
  },
  { addColumn: { table: 'messages', column: 'deleted_at', definition: 'INTEGER' } },
  { addColumn: { table: 'filtered_messages', column: 'deleted_at', definition: 'INTEGER' } },
  { addColumn: { table: 'filtered_messages', column: 'source_id', definition: 'TEXT' } },
  { addColumn: { table: 'bot_messages', column: 'deleted_at', definition: 'INTEGER' } },
  {
    sql: `
  CREATE INDEX IF NOT EXISTS idx_filtered_messages_source_id ON filtered_messages (source_id)
`,
  },
  {
    sql: `
  CREATE TABLE IF NOT EXISTS message_revisions (
    message_id TEXT NOT NULL,
    content TEXT NOT NULL,
    edited_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, edited_at)
  )
`,
  },
];
