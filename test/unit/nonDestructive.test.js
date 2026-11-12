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
const UPDATE_STATEMENT = /\bUPDATE\s+\w+\s+SET\b[^`'"]*/gi;
const SOFT_DELETE_UPDATE =
  /^UPDATE\s+\w+\s+SET\s+deleted_at\s*=\s*\?\s+WHERE\b[\s\S]*\bdeleted_at\s+IS\s+NULL\b/i;
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

const updatesIn = (text) => text.match(UPDATE_STATEMENT) ?? [];

test('every SQL UPDATE in src and scripts is a soft-delete marker guarded by deleted_at IS NULL', () => {
  const updates = sources.flatMap(({ text }) => updatesIn(text));
  assert.ok(updates.length >= 3);
  updates.forEach((statement) => assert.match(statement.trim(), SOFT_DELETE_UPDATE));
});

test('the UPDATE rule rejects overwrites of user data', () => {
  [
    'UPDATE messages SET content = ? WHERE id = ?',
    'UPDATE messages SET deleted_at = ? WHERE id = ?',
    'UPDATE messages SET deleted_at = ?, content = ? WHERE deleted_at IS NULL',
  ].forEach((sql) => assert.doesNotMatch(sql, SOFT_DELETE_UPDATE));
  assert.match('UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', SOFT_DELETE_UPDATE);
});

const FILE_REMOVAL = /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\(/;
const FILE_MOVE = /\b(renameSync|linkSync|copyFileSync)\(/;
const DATABASE_SWITCH = 'src/backfill/databaseSwitch.js';
// The snapshot reader removes only the temporary copy it created itself, never user data.
const TEMP_COPY_CLEANUP = ['src/storage/snapshot.js'];

test('no source file removes or truncates a file', () => {
  const checked = sources.filter(({ file }) => !TEMP_COPY_CLEANUP.includes(file));
  assert.deepEqual(offenders((text) => FILE_REMOVAL.test(text), checked), []);
});

test('only the temporary-copy cleanup removes anything, and only from the OS temp directory', () => {
  const removing = sources.filter(({ text }) => FILE_REMOVAL.test(text)).map(({ file }) => file);
  assert.deepEqual(removing, TEMP_COPY_CLEANUP);
  const snapshot = sources.find(({ file }) => file === TEMP_COPY_CLEANUP[0]).text;
  assert.ok(snapshot.includes('os.tmpdir()'));
});

test('rename, link and copy of files appear only in the database switch', () => {
  const moving = sources.filter(({ text }) => FILE_MOVE.test(text)).map(({ file }) => file);
  assert.deepEqual(moving, [DATABASE_SWITCH]);
});

test('the file rules catch each forbidden call', () => {
  ['fs.unlinkSync(p)', 'fs.rm(p)', 'rmSync(p)', 'fs.rmdir(p)', 'fs.truncateSync(p)', 'fs.promises.unlink(p)']
    .forEach((code) => assert.match(code, FILE_REMOVAL));
  ['fs.renameSync(a, b)', 'linkSync(a, b)', 'fs.copyFileSync(a, b)'].forEach((code) => assert.match(code, FILE_MOVE));
  assert.doesNotMatch('truncateForDiscord(text)', FILE_REMOVAL);
});
