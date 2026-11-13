import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../../src/storage/migrations.js';
import { runMigrations } from '../../../src/storage/database.js';

const FORBIDDEN = /\b(DROP|TRUNCATE|REPLACE|RENAME)\b|\bDELETE\s+FROM\b/i;
const ADDITIVE = /^\s*CREATE (TABLE|INDEX) IF NOT EXISTS\b/;

test('every descriptor is either additive SQL or a nullable add-column', () => {
  MIGRATIONS.forEach((migration, index) => {
    const keys = Object.keys(migration);
    assert.equal(keys.length, 1, `migration ${index}`);
    if (migration.sql) {
      assert.match(migration.sql, ADDITIVE, `migration ${index}`);
      assert.doesNotMatch(migration.sql, FORBIDDEN, `migration ${index}`);
      return;
    }
    const { table, column, definition } = migration.addColumn;
    assert.match(table, /^[a-z_]+$/);
    assert.match(column, /^[a-z_]+$/);
    assert.doesNotMatch(definition, /NOT NULL(?!.*DEFAULT)/i, `migration ${index} must be nullable or have a default`);
  });
});

test('no descriptor repeats another one', () => {
  const keys = MIGRATIONS.map((m) => JSON.stringify(m.addColumn ?? m.sql.replace(/\s+/g, ' ').trim()));
  assert.equal(new Set(keys).size, keys.length);
});

test('running them twice leaves the schema and existing rows untouched', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1', 'a', 'hello', 5)");
  const schema = () => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all());
  const before = schema();
  runMigrations(db);
  assert.equal(schema(), before);
  assert.equal(db.prepare('SELECT content FROM messages').get().content, 'hello');
});

test('they upgrade a database that only has the legacy tables, keeping its rows', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS.slice(0, 3));
  db.exec("INSERT INTO filtered_messages (id, author, content, timestamp, has_gif) VALUES ('1', 'a', 'old row', 5, 0)");
  runMigrations(db);
  const row = db.prepare('SELECT content, deleted_at, source_id FROM filtered_messages').get();
  assert.deepEqual({ ...row }, { content: 'old row', deleted_at: null, source_id: null });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  ['bot_messages', 'user_profiles', 'message_revisions', 'meta'].forEach((name) => assert.ok(tables.includes(name), name));
});

test('the conversation migrations come after the topic bank ones: the table, two nullable columns and the index', () => {
  const tableAt = MIGRATIONS.findIndex((m) => m.sql?.includes('CREATE TABLE IF NOT EXISTS conversations'));
  const topicsAt = MIGRATIONS.findIndex((m) => m.sql?.includes('CREATE TABLE IF NOT EXISTS topic_messages'));
  assert.ok(tableAt > topicsAt);
  assert.deepEqual(MIGRATIONS.slice(tableAt + 1).map((m) => m.addColumn ?? 'sql'), [
    { table: 'bot_messages', column: 'conversation_id', definition: 'TEXT' },
    { table: 'bot_messages', column: 'turn_index', definition: 'INTEGER' },
    'sql',
  ]);
  assert.match(MIGRATIONS.at(-1).sql, /CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation ON bot_messages \(conversation_id\)/);
});
