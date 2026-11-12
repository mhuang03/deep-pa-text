import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from '../../src/storage/migrations.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const FORBIDDEN_SQL =
  /\b(DELETE\s+FROM|DROP\s+(TABLE|INDEX|COLUMN|VIEW)|TRUNCATE|REPLACE\s+INTO|INSERT\s+OR\s+REPLACE)\b/i;
const FORBIDDEN_CALLS = ['deleteCollection(', '.reset('];
const STORAGE_DELETE = '.delete(';
const ADDITIVE_SQL = /^\s*CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i;

const listJsFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const sources = ['src', 'scripts'].flatMap((dir) => listJsFiles(path.join(ROOT, dir)))
  .map((file) => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

const offenders = (isForbidden, files = sources) =>
  files.filter(({ text }) => isForbidden(text)).map(({ file }) => file);

test('scans a non-trivial set of source files', () => {
  assert.ok(sources.some(({ file }) => file === 'src/main.js'));
  assert.ok(sources.some(({ file }) => file.startsWith('scripts/')));
  assert.ok(sources.length > 30);
});

test('no source file contains a destructive SQL statement', () => {
  assert.deepEqual(offenders((text) => FORBIDDEN_SQL.test(text)), []);
});

test('no source file calls deleteCollection or reset', () => {
  assert.deepEqual(offenders((text) => FORBIDDEN_CALLS.some((call) => text.includes(call))), []);
});

test('nothing under src/storage calls .delete(', () => {
  const storage = sources.filter(({ file }) => file.startsWith('src/storage/'));
  assert.ok(storage.length > 0);
  assert.deepEqual(offenders((text) => text.includes(STORAGE_DELETE), storage), []);
});

test('the forbidden-SQL pattern catches each destructive form', () => {
  [
    'DELETE FROM messages', 'drop table messages', 'DROP INDEX i', 'DROP COLUMN c', 'DROP VIEW v',
    'TRUNCATE messages', 'REPLACE INTO messages', 'INSERT OR REPLACE INTO messages',
  ].forEach((sql) => assert.match(sql, FORBIDDEN_SQL));
  assert.doesNotMatch('ON DELETE SET NULL', FORBIDDEN_SQL);
});

test('every migration is a valid additive descriptor', () => {
  assert.ok(MIGRATIONS.length > 0);
  MIGRATIONS.forEach((migration) => {
    const keys = Object.keys(migration);
    assert.equal(keys.length, 1, 'a descriptor has exactly one of sql or addColumn');
    if (migration.sql !== undefined) {
      assert.equal(typeof migration.sql, 'string');
      assert.match(migration.sql, ADDITIVE_SQL);
      return;
    }
    const { table, column, definition } = migration.addColumn;
    [table, column, definition].forEach((part) => assert.equal(typeof part, 'string'));
    assert.ok(table && column && definition);
  });
});
