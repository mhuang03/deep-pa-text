import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../src/storage/database.js';
import { createMetaStore } from '../../../src/storage/metaStore.js';
import { createDatabaseSwitch } from '../../../src/backfill/databaseSwitch.js';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

const setup = (t, { withDb = true, fsOverrides = {} } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-switch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'messages.db');
  if (withDb) {
    const handle = openDatabase(db);
    handle.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('1','a','one',1)");
    handle.close();
  }
  const dbSwitch = createDatabaseSwitch({
    fs: { ...fs, ...fsOverrides }, openDatabase, createMetaStore, logger,
  });
  return { dir, db, dbSwitch };
};

const touch = (file) => fs.writeFileSync(file, '');
const setMeta = (file, entries) => {
  const handle = openDatabase(file);
  const meta = createMetaStore({ db: handle });
  Object.entries(entries).forEach(([key, value]) => meta.setIfAbsent(key, value));
  handle.close();
};

test('inspect: ready for a lone database', (t) => {
  const { db, dbSwitch } = setup(t);
  assert.deepEqual(dbSwitch.inspect(db), { state: 'ready', reason: null });
});

test('inspect tolerates a database without a meta table', (t) => {
  const { db, dbSwitch } = setup(t, { withDb: false });
  const legacy = new DatabaseSync(db);
  legacy.exec('CREATE TABLE messages (id TEXT PRIMARY KEY)');
  legacy.close();
  touch(`${db}.old`);
  assert.equal(dbSwitch.inspect(db).state, 'blocked');
});

test('inspect: blocked when the database is missing, naming the file', (t) => {
  const { db, dbSwitch } = setup(t, { withDb: false });
  const result = dbSwitch.inspect(db);
  assert.equal(result.state, 'blocked');
  assert.ok(result.reason.includes(db));
  assert.match(result.reason, /backfill/);
});

test('inspect: blocked by each journal file', (t) => {
  ['-journal', '-wal', '-shm'].forEach((suffix) => {
    const { db, dbSwitch } = setup(t);
    touch(`${db}${suffix}`);
    const result = dbSwitch.inspect(db);
    assert.equal(result.state, 'blocked');
    assert.ok(result.reason.includes(`${db}${suffix}`));
  });
});

test('inspect: interrupted before the backup when only .new exists', (t) => {
  const { db, dbSwitch } = setup(t);
  touch(`${db}.new`);
  assert.equal(dbSwitch.inspect(db).state, 'interrupted-before-backup');
});

test('inspect: interrupted before the swap when .new and .old exist', (t) => {
  const { db, dbSwitch } = setup(t);
  touch(`${db}.new`);
  touch(`${db}.old`);
  assert.equal(dbSwitch.inspect(db).state, 'interrupted-before-swap');
});

test('inspect: in progress when .old exists and the database started but did not complete', (t) => {
  const { db, dbSwitch } = setup(t);
  touch(`${db}.old`);
  setMeta(db, { reimport_started_at: '5' });
  assert.equal(dbSwitch.inspect(db).state, 'in-progress');
});

test('inspect: blocked when .old sits next to a finished database', (t) => {
  const { db, dbSwitch } = setup(t);
  touch(`${db}.old`);
  setMeta(db, { reimport_started_at: '5', reimport_completed_at: '6' });
  const result = dbSwitch.inspect(db);
  assert.equal(result.state, 'blocked');
  assert.ok(result.reason.includes(`${db}.old`));
  assert.doesNotMatch(result.reason, /delete (it|the)/i);
});

test('inspect: blocked when .old sits next to an ordinary database, and opening it never writes', (t) => {
  const { db, dbSwitch } = setup(t);
  touch(`${db}.old`);
  const before = fs.readFileSync(db);
  assert.equal(dbSwitch.inspect(db).state, 'blocked');
  assert.deepEqual(fs.readFileSync(db), before);
  assert.deepEqual(fs.readdirSync(path.dirname(db)).sort(), ['messages.db', 'messages.db.old']);
});

test('prepare creates a migrated .new database with the generation and start time', (t) => {
  const { db, dbSwitch } = setup(t);
  dbSwitch.prepare(db, { generation: 'g1', startedAt: 42 });
  const handle = openDatabase(`${db}.new`, { readOnly: true });
  const meta = createMetaStore({ db: handle });
  assert.equal(meta.get('chroma_generation'), 'g1');
  assert.equal(meta.get('reimport_started_at'), '42');
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  handle.close();
});

test('backup hard-links the database, so the content is identical and nothing is copied', (t) => {
  const { db, dbSwitch } = setup(t);
  assert.equal(dbSwitch.backup(db), `${db}.old`);
  assert.equal(fs.statSync(db).ino, fs.statSync(`${db}.old`).ino);
});

test('backup falls back to a byte-identical copy when links are unsupported', (t) => {
  const error = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  const { db, dbSwitch } = setup(t, { fsOverrides: { linkSync: () => { throw error; } } });
  dbSwitch.backup(db);
  assert.notEqual(fs.statSync(db).ino, fs.statSync(`${db}.old`).ino);
  assert.deepEqual(fs.readFileSync(`${db}.old`), fs.readFileSync(db));
});

test('backup refuses to overwrite an existing .old, by link and by copy', (t) => {
  const linked = setup(t);
  fs.writeFileSync(`${linked.db}.old`, 'keep me');
  assert.throws(() => linked.dbSwitch.backup(linked.db), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(`${linked.db}.old`, 'utf8'), 'keep me');
  const error = Object.assign(new Error('nope'), { code: 'EPERM' });
  const copied = setup(t, { fsOverrides: { linkSync: () => { throw error; } } });
  fs.writeFileSync(`${copied.db}.old`, 'keep me too');
  assert.throws(() => copied.dbSwitch.backup(copied.db), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(`${copied.db}.old`, 'utf8'), 'keep me too');
});

test('backup does not swallow link errors other than the unsupported ones', (t) => {
  const error = Object.assign(new Error('disk on fire'), { code: 'EIO' });
  const { db, dbSwitch } = setup(t, { fsOverrides: { linkSync: () => { throw error; } } });
  assert.throws(() => dbSwitch.backup(db), /disk on fire/);
  assert.equal(fs.existsSync(`${db}.old`), false);
});

test('backup verifies that the backup holds a messages table', (t) => {
  const { db, dbSwitch } = setup(t, { withDb: false });
  new DatabaseSync(db).close();
  assert.throws(() => dbSwitch.backup(db), /no messages table/);
});

test('swap replaces the database atomically and keeps the old content under .old', (t) => {
  const { db, dbSwitch } = setup(t);
  dbSwitch.prepare(db, { generation: 'g1', startedAt: 1 });
  dbSwitch.backup(db);
  dbSwitch.swap(db);
  assert.equal(fs.existsSync(`${db}.new`), false);
  const fresh = openDatabase(db, { readOnly: true });
  assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  fresh.close();
  const old = openDatabase(`${db}.old`, { readOnly: true });
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  old.close();
});
