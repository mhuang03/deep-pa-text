import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  connect, withArchive, verifyBeforeSwap, switchDatabase, toImported, compare, importAll,
} from '../../../src/backfill/reimportSteps.js';
import { switchPaths } from '../../../src/backfill/switchState.js';

const DB = '/x/messages.db';
const baseCtx = (overrides = {}) => ({
  dbPath: DB, paths: switchPaths(DB), clock: { now: () => 1_700_000_000_000 }, ...overrides,
});

test('switchDatabase for a fresh run prepares, backs up and swaps in order, returning the generation', () => {
  const calls = [];
  const databaseSwitch = {
    prepare: (db, options) => calls.push(['prepare', db, options]),
    backup: (db) => calls.push(['backup', db]),
    swap: (db) => calls.push(['swap', db]),
  };
  const generation = switchDatabase(baseCtx({ databaseSwitch }), { state: 'ready' }, false);
  assert.match(generation, /^g\d{14}$/);
  assert.deepEqual(calls.map((call) => call[0]), ['prepare', 'backup', 'swap']);
  assert.deepEqual(calls[0][2], { generation, startedAt: 1_700_000_000_000 });
});

test('switchDatabase on resume verifies the backup and swaps only before the swap', () => {
  const calls = [];
  const databaseSwitch = {
    verifyBackup: (...args) => calls.push(['verify', ...args]),
    swap: () => calls.push(['swap']),
  };
  const ctx = baseCtx({ databaseSwitch });
  assert.equal(switchDatabase(ctx, { state: 'interrupted-before-swap' }, true), null);
  assert.deepEqual(calls.map((call) => call[0]), ['verify', 'swap']);
  calls.length = 0;
  assert.equal(switchDatabase(ctx, { state: 'in-progress' }, true), null);
  assert.deepEqual(calls, []);
});

test('verifyBeforeSwap wraps a failed verification in advice that names the original as intact', () => {
  const databaseSwitch = { verifyBackup: () => { throw new Error('backup is short'); } };
  assert.throws(
    () => verifyBeforeSwap(baseCtx({ databaseSwitch }), { state: 'interrupted-before-swap' }),
    /backup is short.*original database is intact/s,
  );
  assert.doesNotThrow(() => verifyBeforeSwap(baseCtx({ databaseSwitch }), { state: 'in-progress' }));
});

test('withArchive refuses a missing file and closes the handle after use', async () => {
  const closed = [];
  const ctx = {
    fs: { existsSync: (file) => file === 'there.db' },
    config: { storage: { busyTimeoutMs: 5 } },
    openDatabase: () => Object.assign(new DatabaseSync(':memory:'), { close: () => closed.push(true) }),
  };
  await assert.rejects(withArchive(ctx, 'gone.db', async () => 1), /Expected the previous database at gone\.db/);
  assert.equal(await withArchive(ctx, 'there.db', async (archive) => archive.counts().raw), 0);
  await assert.rejects(withArchive(ctx, 'there.db', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(closed.length, 2);
});

test('toImported flattens the bot message counts', () => {
  assert.deepEqual(toImported({
    insertedRaw: 4, kept: 3, botMessages: { imported: 2, unattributed: 1, skippedEmpty: 5, alreadyStored: 9 },
  }), {
    insertedRaw: 4, kept: 3, botMessages: 2, unattributedBotMessages: 1, skippedEmptyBotMessages: 5,
  });
});

test('connect destroys the client when the login fails', async () => {
  let destroyed = false;
  const client = {
    once: () => {},
    login: async () => { throw new Error('bad token'); },
    destroy: async () => { destroyed = true; },
    channels: { fetch: async () => ({}) },
  };
  const ctx = { config: { discord: { token: 't', channelId: 'c' } }, vendor: { Client: class {} }, createDiscordClient: () => client };
  await assert.rejects(connect(ctx), /bad token/);
  assert.equal(destroyed, true);
});

const emptyDb = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)');
  return db;
};

test('compare reads the backup and the new database with the configured page size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-steps-'));
  const backup = path.join(dir, 'old.db');
  const old = new DatabaseSync(backup);
  old.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)');
  old.exec("INSERT INTO messages VALUES ('1', 'a'), ('2', 'b')");
  old.close();
  const ctx = {
    fs, config: { storage: { busyTimeoutMs: 5 }, backfill: { comparisonPageSize: 1 } },
    openDatabase: (file) => new DatabaseSync(file),
    paths: { backup },
  };
  const container = { db: emptyDb(), messageStore: { getRaw: (id) => (id === '1' ? { content: 'a' } : null) } };
  const result = await compare(ctx, container);
  fs.rmSync(dir, { recursive: true });
  assert.equal(result.missingInNew, 1);
  assert.equal(result.changedContent, 0);
});

test('importAll carries profiles over, imports and syncs, then records completion', async () => {
  const recorded = [];
  const meta = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-steps-'));
  const backup = path.join(dir, 'old.db');
  const old = new DatabaseSync(backup);
  old.exec('CREATE TABLE user_profiles (username TEXT, user_id TEXT, display_name TEXT, avatar_url TEXT, observed_at INTEGER)');
  old.exec("INSERT INTO user_profiles VALUES ('alice', 'u1', 'Alice', NULL, 7)");
  old.close();
  const ctx = {
    fs, config: { storage: { busyTimeoutMs: 5 } }, openDatabase: (file) => new DatabaseSync(file),
    paths: { backup }, clock: { now: () => 42 },
  };
  const container = {
    profileStore: { record: (row) => recorded.push(row) },
    historyImporter: { importMessages: async (messages, options) => ({ messages, known: options.botMessageLookup('x') }) },
    vectorSync: { run: async () => ({ checked: 0 }) },
    metaStore: { setIfAbsent: (...args) => meta.push(args) },
  };
  const result = await importAll(ctx, { container, channel: { id: 'c' }, messages: ['m'] });
  fs.rmSync(dir, { recursive: true });
  assert.deepEqual(recorded, [{ username: 'alice', userId: 'u1', displayName: 'Alice', avatarURL: null, observedAt: 7 }]);
  assert.deepEqual(result.result, { messages: ['m'], known: null });
  assert.deepEqual(result.sync, { checked: 0 });
  assert.deepEqual(meta, [['reimport_completed_at', '42']]);
});
