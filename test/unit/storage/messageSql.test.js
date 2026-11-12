import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import * as sql from '../../../src/storage/messageSql.js';

const STATIC = Object.entries(sql).filter(([, value]) => typeof value === 'string');
const GENERATORS = {
  countsSql: [2], parentsSql: [2], hiddenSql: [2], latestFrom: ['messages', 'deleted_at IS NULL'],
};

test('every static statement prepares against the migrated schema', () => {
  const db = openDatabase(':memory:');
  STATIC.forEach(([name, text]) => assert.doesNotThrow(() => db.prepare(text), name));
  assert.ok(STATIC.length >= 15);
});

test('every statement generator prepares with the given parameters', () => {
  const db = openDatabase(':memory:');
  Object.entries(GENERATORS).forEach(([name, args]) => assert.doesNotThrow(() => db.prepare(sql[name](...args)), name));
});

test('generated IN lists have one placeholder per value', () => {
  assert.match(sql.countsSql(3), /content IN \(\?, \?, \?\)/);
  assert.match(sql.parentsSql(1), /m\.id IN \(\?\)/);
  assert.match(sql.hiddenSql(2), /id IN \(\?, \?\)/);
});

test('inserts are conflict-safe and no statement deletes or replaces', () => {
  [sql.INSERT_RAW, sql.INSERT_FILTERED, sql.INSERT_REVISION].forEach((text) => assert.match(text, /ON CONFLICT\(.*\) DO NOTHING/));
  STATIC.forEach(([, text]) => assert.doesNotMatch(text, /\b(DELETE|DROP|TRUNCATE|REPLACE)\b/i));
});

test('the delete markers only touch rows that are still visible', () => {
  const db = openDatabase(':memory:');
  db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1', 'a', 'x', 1)");
  assert.equal(Number(db.prepare(sql.MARK_RAW_DELETED).run(50, '1').changes), 1);
  assert.equal(Number(db.prepare(sql.MARK_RAW_DELETED).run(99, '1').changes), 0);
  assert.equal(db.prepare('SELECT deleted_at FROM messages').get().deleted_at, 50);
});

test('NEWEST_RAW includes deleted rows while NEWEST_RAW_VISIBLE skips them', () => {
  const db = openDatabase(':memory:');
  db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1', 'a', 'x', 1), ('2', 'a', 'y', 2)");
  db.exec("UPDATE messages SET deleted_at = 9 WHERE id = '2'");
  assert.equal(db.prepare(sql.NEWEST_RAW).get().id, '2');
  assert.equal(db.prepare(sql.NEWEST_RAW_VISIBLE).get().id, '1');
});

test('RANDOM_MESSAGES honours the author, the cutoff and visibility', () => {
  const db = openDatabase(':memory:');
  const insert = db.prepare('INSERT INTO filtered_messages (id, author, content, timestamp, has_gif) VALUES (?, ?, ?, ?, 0)');
  insert.run('1', 'a', 'old', 1);
  insert.run('2', 'a', 'new', 9);
  insert.run('3', 'b', 'other', 1);
  db.exec("UPDATE filtered_messages SET deleted_at = 5 WHERE id = '1'");
  const rows = (before) => db.prepare(sql.RANDOM_MESSAGES).all('a', before, before, 10).map((r) => r.id);
  assert.deepEqual(rows(null), ['2']);
  assert.deepEqual(rows(5), []);
});

test('PAGE_FILTERED pages by an exclusive (timestamp, id) cursor over visible rows', () => {
  const db = openDatabase(':memory:');
  const insert = db.prepare('INSERT INTO filtered_messages (id, author, content, timestamp, has_gif) VALUES (?, ?, ?, ?, 0)');
  insert.run('a', 'x', 'c', 1);
  insert.run('b', 'x', 'c', 1);
  insert.run('c', 'x', 'c', 2);
  db.exec("UPDATE filtered_messages SET deleted_at = 3 WHERE id = 'c'");
  const page = (ts, id) => db.prepare(sql.PAGE_FILTERED).all(ts, id, 10).map((r) => r.id);
  assert.deepEqual(page(-1, ''), ['a', 'b']);
  assert.deepEqual(page(1, 'a'), ['b']);
});
