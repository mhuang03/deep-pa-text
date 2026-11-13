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

test('creates the author and content index for frequency counts, idempotently', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  assert.ok(names(db, 'index').includes('idx_filtered_messages_author_content'));
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
  assert.deepEqual(columns(db, 'messages'), ['id', 'author', 'content', 'timestamp', 'reference', 'deleted_at']);
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
  assert.deepEqual(columns(db, 'bot_messages'), ['id', 'persona', 'content', 'timestamp', 'reference', 'trigger', 'deleted_at', 'conversation_id', 'turn_index']);
  assert.ok(names(db, 'index').includes('idx_bot_messages_timestamp'));
  assert.ok(names(db, 'index').includes('idx_bot_messages_conversation'));
});

test('spec 24 migrations add the soft-delete columns, index and revisions table to a legacy database, once', () => {
  const db = new DatabaseSync(':memory:');
  MIGRATIONS.slice(0, 7).forEach((m) => db.exec(m.sql));
  db.prepare('INSERT INTO messages (id, author, content, timestamp) VALUES (?, ?, ?, ?)').run('1', 'a', 'raw', 5);
  db.prepare('INSERT INTO filtered_messages (id, author, content, timestamp, reference, has_gif) VALUES (?, ?, ?, ?, ?, ?)')
    .run('1', 'a', 'kept', 5, null, 0);
  db.prepare('INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger) VALUES (?, ?, ?, ?, ?, ?)')
    .run('b', 'bob', 'hi', 6, null, 'auto');
  runMigrations(db);
  runMigrations(db);
  assert.ok(columns(db, 'messages').includes('deleted_at'));
  assert.ok(columns(db, 'filtered_messages').includes('deleted_at'));
  assert.ok(columns(db, 'filtered_messages').includes('source_id'));
  assert.ok(columns(db, 'bot_messages').includes('deleted_at'));
  assert.deepEqual(columns(db, 'message_revisions'), ['message_id', 'content', 'edited_at']);
  assert.ok(names(db, 'index').includes('idx_filtered_messages_source_id'));
  assert.deepEqual(db.prepare('SELECT content, deleted_at, source_id FROM filtered_messages').all()
    .map((r) => ({ ...r })), [{ content: 'kept', deleted_at: null, source_id: null }]);
  assert.equal(db.prepare('SELECT content FROM messages').get().content, 'raw');
  assert.equal(db.prepare('SELECT deleted_at FROM bot_messages').get().deleted_at, null);
});

const busyTimeout = (db) => db.prepare('PRAGMA busy_timeout').get().timeout;

test('sets the busy timeout on every handle, read-only ones included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-db-'));
  const file = path.join(dir, 'm.db');
  const writable = openDatabase(file, { busyTimeoutMs: 1234 });
  const readOnly = openDatabase(file, { readOnly: true, busyTimeoutMs: 4321 });
  assert.equal(busyTimeout(writable), 1234);
  assert.equal(busyTimeout(readOnly), 4321);
  writable.close();
  readOnly.close();
  fs.rmSync(dir, { recursive: true });
});

test('the busy timeout defaults to the configured default', () => {
  assert.equal(busyTimeout(openDatabase(':memory:')), 5000);
});
