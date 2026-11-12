import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../../../src/storage/database.js';
import { MIGRATIONS } from '../../../src/storage/migrations.js';

const names = (db, type) =>
  db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type).map((r) => r.name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

test('creates both tables and the timestamp index', () => {
  const db = openDatabase(':memory:');
  assert.ok(names(db, 'table').includes('messages'));
  assert.ok(names(db, 'table').includes('filtered_messages'));
  assert.ok(names(db, 'index').includes('idx_filtered_messages_timestamp'));
});

test('every migration descriptor is additive', () => {
  MIGRATIONS.forEach((m) => {
    if (m.sql) assert.match(m.sql.trim(), /^CREATE (TABLE|INDEX) IF NOT EXISTS/);
    else assert.ok(m.addColumn.table && m.addColumn.column && m.addColumn.definition);
  });
});

test('running migrations twice is a no-op', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO messages (id, author, content, timestamp) VALUES (?, ?, ?, ?)')
    .run('1', 'a', 'hello', 5);
  runMigrations(db);
  runMigrations(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('keeps every row of a database created with the legacy schema', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS[0].sql);
  db.exec(MIGRATIONS[1].sql);
  db.prepare('INSERT INTO messages (id, author, content, timestamp, reference) VALUES (?, ?, ?, ?, ?)')
    .run('1', 'a', 'raw', 5, null);
  db.prepare('INSERT INTO filtered_messages (id, author, content, timestamp, reference, has_gif) VALUES (?, ?, ?, ?, ?, ?)')
    .run('1', 'a', 'kept', 5, null, 0);
  runMigrations(db);
  assert.equal(db.prepare('SELECT content FROM messages').get().content, 'raw');
  assert.equal(db.prepare('SELECT content FROM filtered_messages').get().content, 'kept');
  assert.ok(names(db, 'index').includes('idx_filtered_messages_timestamp'));
});

test('addColumn adds the column once and skips it when present', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const add = [{ addColumn: { table: 'messages', column: 'deleted_at', definition: 'INTEGER' } }];
  runMigrations(db, add);
  runMigrations(db, add);
  assert.equal(columns(db, 'messages').filter((c) => c === 'deleted_at').length, 1);
});

test('addColumn is skipped when the column already exists', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  runMigrations(db, [{ addColumn: { table: 'messages', column: 'author', definition: 'TEXT' } }]);
  assert.deepEqual(columns(db, 'messages'), ['id', 'author', 'content', 'timestamp', 'reference']);
});

test('readOnly rejects writes and does not run migrations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-db-'));
  const file = path.join(dir, 'm.db');
  openDatabase(file).close();
  const ro = openDatabase(file, { readOnly: true });
  assert.throws(() => ro.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1','a','b',1)"));
  ro.close();
  fs.rmSync(dir, { recursive: true });
});

test('adds the bot_messages table and index, idempotently, to a legacy database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS[0].sql);
  runMigrations(db);
  runMigrations(db);
  assert.deepEqual(columns(db, 'bot_messages'), ['id', 'persona', 'content', 'timestamp', 'reference', 'trigger']);
  assert.ok(names(db, 'index').includes('idx_bot_messages_timestamp'));
});
