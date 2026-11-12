import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../../src/storage/migrations.js';
import { openDatabase } from '../../../src/storage/database.js';
import { createArchiveReader } from '../../../src/backfill/archiveReader.js';

const tempFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'messages.db');
};

const seededFile = (t) => {
  const file = tempFile(t);
  const db = openDatabase(file);
  db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1','a','one',1),('2','a','two',2),('3','b','three',3)");
  db.exec("INSERT INTO filtered_messages (id, author, content, timestamp, has_gif) VALUES ('1','a','one',1,0)");
  db.exec("INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger) VALUES ('b1','carol','hi <gif! x>',5,'1','reply')");
  db.exec("INSERT INTO user_profiles (username, display_name, observed_at) VALUES ('bob','Bob',9)");
  db.close();
  return file;
};

test('reads bot messages, profiles, counts and raw pages from a read-only handle', (t) => {
  const archive = createArchiveReader({ db: openDatabase(seededFile(t), { readOnly: true }) });
  assert.deepEqual(archive.botMessage('b1'), { persona: 'carol', content: 'hi <gif! x>', reference: '1', trigger: 'reply' });
  assert.equal(archive.botMessage('nope'), null);
  assert.equal(archive.profiles()[0].display_name, 'Bob');
  assert.deepEqual(archive.counts(), { raw: 3, corpus: 1, botMessages: 1 });
  assert.deepEqual(archive.rawPage({ limit: 2 }).map((r) => r.id), ['1', '2']);
  assert.deepEqual(archive.rawPage({ afterId: '2', limit: 5 }), [{ id: '3', content: 'three' }]);
});

test('the handle is read-only', (t) => {
  const db = openDatabase(seededFile(t), { readOnly: true });
  createArchiveReader({ db });
  assert.throws(() => db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('9','a','x',1)"));
});

test('a database from before the later tables reads as empty without error', (t) => {
  const file = tempFile(t);
  const legacy = new DatabaseSync(file);
  MIGRATIONS.slice(0, 2).forEach((m) => legacy.exec(m.sql));
  legacy.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1','a','one',1)");
  legacy.close();
  const archive = createArchiveReader({ db: openDatabase(file, { readOnly: true }) });
  assert.equal(archive.botMessage('b1'), null);
  assert.deepEqual(archive.profiles(), []);
  assert.deepEqual(archive.counts(), { raw: 1, corpus: 0, botMessages: 0 });
  assert.equal(archive.rawPage({ limit: 5 }).length, 1);
});

test('a database with no tables at all counts zero', () => {
  const archive = createArchiveReader({ db: new DatabaseSync(':memory:') });
  assert.deepEqual(archive.counts(), { raw: 0, corpus: 0, botMessages: 0 });
  assert.deepEqual(archive.rawPage({ limit: 5 }), []);
});
