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
];
