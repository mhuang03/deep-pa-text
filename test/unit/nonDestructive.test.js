import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from '../../src/storage/migrations.js';
import {
  DATABASE_SWITCH, addColumnViolations, chromaViolations, fileViolations, isSqlString, sqlViolations,
} from '../support/nonDestructive.js';

const ROOT = new URL('../../', import.meta.url).pathname;

const listJsFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const sources = ['src', 'scripts'].flatMap((dir) => listJsFiles(path.join(ROOT, dir)))
  .map((file) => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

const offenders = (check) => sources.flatMap(({ file, text }) => check(text, file).map((hit) => `${file}: ${hit}`));

test('scans a non-trivial set of source files', () => {
  assert.ok(sources.some(({ file }) => file === 'src/main.js'));
  assert.ok(sources.some(({ file }) => file.startsWith('scripts/')));
  assert.ok(sources.length > 30);
});

test('every SQL statement in src and scripts is on the allow-list', () => {
  assert.deepEqual(offenders(sqlViolations), []);
});

test('the SQL scan finds the statements the allow-list is meant to cover', () => {
  const statements = sources.flatMap(({ text }) => text.match(/UPDATE\s+\w+\s+SET\s+deleted_at/g) ?? []);
  assert.ok(statements.length >= 3);
});

test('every migration is an additive descriptor with a safe column definition', () => {
  assert.ok(MIGRATIONS.length > 0);
  MIGRATIONS.forEach((migration) => {
    const keys = Object.keys(migration);
    assert.equal(keys.length, 1, 'a descriptor has exactly one of sql or addColumn');
    if (migration.sql !== undefined) {
      assert.deepEqual(sqlViolations(`const q = \`${migration.sql}\`;`), []);
      return;
    }
    const { table, column, definition } = migration.addColumn;
    [table, column, definition].forEach((part) => assert.equal(typeof part, 'string'));
    assert.deepEqual(addColumnViolations(definition), [], `${table}.${column}`);
  });
});

test('no Chroma collection is deleted, modified, reset or updated, and writes stay in the vector store', () => {
  assert.deepEqual(offenders(chromaViolations), []);
});

test('no source file removes, truncates, writes, copies, renames or links a file outside the database switch', () => {
  assert.deepEqual(offenders(fileViolations), []);
});

test('the database switch is the only place that moves files', () => {
  const calls = sources.filter(({ file, text }) => file !== DATABASE_SWITCH && /\b(renameSync|linkSync|copyFileSync)\(/.test(text));
  assert.deepEqual(calls, []);
  const own = sources.find(({ file }) => file === DATABASE_SWITCH);
  assert.deepEqual(fileViolations(own.text, DATABASE_SWITCH), []);
});

const BAD_SQL = [
  'DELETE FROM messages', 'delete from messages where id = ?', 'DROP TABLE messages', 'drop index i', 'DROP VIEW v',
  'TRUNCATE TABLE messages', 'REPLACE INTO messages (id) VALUES (?)', 'INSERT OR REPLACE INTO messages (id) VALUES (?)',
  'INSERT OR IGNORE INTO messages (id) VALUES (?)',
  'INSERT INTO messages (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET content = excluded.content',
  'UPDATE OR REPLACE messages SET content = ? WHERE id = ?', 'UPDATE messages SET content = ? WHERE id = ?',
  'UPDATE messages SET deleted_at = ? WHERE id = ?',
  'UPDATE messages SET deleted_at = ?, content = ? WHERE deleted_at IS NULL',
  'ALTER TABLE messages RENAME TO old', 'ALTER TABLE messages DROP COLUMN content', 'VACUUM', 'VACUUM INTO \'x.db\'',
  'ATTACH DATABASE \'x.db\' AS other', 'DETACH DATABASE other', 'REINDEX messages',
  'WITH gone AS (SELECT id FROM messages) DELETE FROM messages WHERE id IN gone',
  'CREATE TABLE messages (id TEXT)', 'CREATE INDEX i ON messages (id)',
];
const GOOD_SQL = [
  'SELECT * FROM messages', 'WITH t AS (SELECT 1) SELECT * FROM t',
  'INSERT INTO messages (id) VALUES (?) ON CONFLICT(id) DO NOTHING', 'INSERT INTO messages (id) VALUES (?)',
  'CREATE TABLE IF NOT EXISTS t (id TEXT)', 'CREATE INDEX IF NOT EXISTS i ON t (id)',
  'ALTER TABLE t ADD COLUMN c INTEGER', 'PRAGMA busy_timeout = 5', 'BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK',
  'UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
];

test('each destructive SQL form is reported, in strings and in templates', () => {
  BAD_SQL.forEach((sql) => {
    assert.equal(sqlViolations(`db.exec('${sql.replace(/'/g, '\\\'')}');`).length, 1, sql);
    assert.equal(sqlViolations(`const q = \`\n  ${sql}\n\`;`).length, 1, sql);
  });
});

test('interpolations are replaced before a template is checked', () => {
  assert.equal(sqlViolations('const q = `DELETE FROM ${table} WHERE id = ?`;').length, 1);
  assert.deepEqual(sqlViolations('const q = `SELECT * FROM ${table} WHERE ${where} ORDER BY timestamp`;'), []);
});

test('each allowed SQL form passes and prose that merely starts with a verb is not SQL', () => {
  GOOD_SQL.forEach((sql) => assert.deepEqual(sqlViolations(`db.exec('${sql}');`), [], sql));
  ['Update available', 'Create a reply', 'with sqlite3) so it recovers', 'Begin the import now'].forEach((text) => {
    assert.equal(isSqlString(text), false, text);
  });
});

test('SQL in comments is not scanned and SQL in code strings is', () => {
  assert.deepEqual(sqlViolations('// DELETE FROM messages\n/* DROP TABLE x */ const a = 1;'), []);
  assert.equal(sqlViolations('const a = /[\'"]/; db.exec("DROP TABLE messages");').length, 1);
});

test('column definitions with NOT NULL but no DEFAULT, PRIMARY KEY, UNIQUE or REFERENCES are reported', () => {
  ['TEXT NOT NULL', 'TEXT PRIMARY KEY', 'TEXT UNIQUE', 'TEXT REFERENCES messages(id)'].forEach((definition) => {
    assert.ok(addColumnViolations(definition).length > 0, definition);
  });
  ['INTEGER', 'TEXT', 'INTEGER NOT NULL DEFAULT 0', 'TEXT DEFAULT NULL'].forEach((definition) => {
    assert.deepEqual(addColumnViolations(definition), [], definition);
  });
});

test('Chroma calls are matched by receiver: collections are guarded, Maps, Sets and hashes are not', () => {
  const bad = [
    'await collection.delete({ ids });', 'await messagesCollection.update({ ids });', 'await repliesCollection.modify({});',
    'await client.deleteCollection({ name });', 'await client.reset();', 'await this.collection.delete({});',
    'await (await client.getOrCreateCollection({ name })).delete({ ids });',
  ];
  bad.forEach((code) => assert.ok(chromaViolations(code, 'src/storage/vectorStore.js').length > 0, code));
  const good = ['seen.delete(id);', 'seen.add(id);', 'hash.update(buffer);', 'cache.delete(channel.id);', 'terms.delete("gif");'];
  good.forEach((code) => assert.deepEqual(chromaViolations(code, 'src/bot/x.js'), [], code));
});

test('collection upsert and add are allowed only in the vector-store files', () => {
  const code = 'await repliesCollection.upsert(body); await messagesCollection.add(body);';
  assert.deepEqual(chromaViolations(code, 'src/storage/vectorStore.js'), []);
  assert.equal(chromaViolations(code, 'src/bot/responder.js').length, 2);
  assert.equal(chromaViolations(code, 'scripts/backfill.js').length, 2);
});

test('every file removal, write, copy, rename and link call is reported, sync and promise variants alike', () => {
  const names = ['rm', 'rmdir', 'unlink', 'truncate', 'ftruncate', 'writeFile', 'appendFile', 'cp', 'copyFile', 'rename', 'link'];
  names.flatMap((name) => [name, `${name}Sync`]).forEach((name) => {
    assert.equal(fileViolations(`fs.${name}(p);`, 'src/x.js').length, 1, name);
    assert.equal(fileViolations(`await fs.promises.${name}(p);`, 'src/x.js').length, 1, name);
    assert.equal(fileViolations(`${name}(p);`, 'scripts/x.js').length, 1, name);
  });
  assert.deepEqual(fileViolations('truncateForDiscord(text); fs.existsSync(p); fs.readFileSync(p);', 'src/x.js'), []);
});

test('renameSync, linkSync and copyFileSync are allowed only in the database switch', () => {
  const code = 'fs.renameSync(a, b); fs.linkSync(a, b); fs.copyFileSync(a, b);';
  assert.deepEqual(fileViolations(code, DATABASE_SWITCH), []);
  assert.equal(fileViolations(code, 'src/storage/database.js').length, 3);
  assert.equal(fileViolations('fs.unlinkSync(a); fs.writeFileSync(a, b);', DATABASE_SWITCH).length, 2);
});
