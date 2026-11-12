import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS } from '../../../src/storage/migrations.js';
import { openDatabase } from '../../../src/storage/database.js';
import { openReadable } from '../../../src/storage/snapshot.js';

const makeDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-snap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'messages.db');
};

test('a current database is opened read-only and directly', async (t) => {
  const file = makeDir(t);
  openDatabase(file).close();
  const readable = await openReadable(file);
  assert.equal(readable.db, readable.source);
  assert.throws(() => readable.db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1','a','b',1)"));
  readable.close();
});

test('a legacy database is read through a migrated copy and left untouched', async (t) => {
  const file = makeDir(t);
  const legacy = new DatabaseSync(file);
  MIGRATIONS.slice(0, 2).forEach((m) => legacy.exec(m.sql));
  legacy.prepare('INSERT INTO messages (id, author, content, timestamp) VALUES (?, ?, ?, ?)').run('1', 'a', 'raw', 5);
  legacy.close();
  const before = fs.readFileSync(file);
  const readable = await openReadable(file);
  assert.notEqual(readable.db, readable.source);
  assert.equal(readable.db.prepare('SELECT deleted_at FROM messages').get().deleted_at, null);
  readable.close();
  assert.deepEqual(fs.readFileSync(file), before);
});
