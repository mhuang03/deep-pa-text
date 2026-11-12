import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { loadConfig } from '../../../src/config.js';

const SCRIPT = new URL('../../../scripts/inspectDb.js', import.meta.url).pathname;
const T0 = Date.parse('2026-11-12T18:00:00Z');

const makeDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-inspect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const seed = (dir) => {
  const config = loadConfig({});
  const db = openDatabase(path.join(dir, 'messages.db'));
  const store = createMessageStore({ db, config });
  const rows = [
    { id: 'a', author: 'alice', content: 'first message here', timestamp: T0, reference: null },
    { id: 'b', author: 'bob', content: 'reply <gif! cat> here', timestamp: T0 + 1000, reference: 'a' },
  ];
  rows.forEach((row) => {
    store.insertRaw(row);
    store.insertFiltered(row);
  });
  db.close();
};

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

test('prints the four sections from a seeded database', (t) => {
  const dir = makeDir(t);
  seed(dir);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  assert.deepEqual(lines.filter((line) => line.endsWith(':')), [
    'Latest messages:',
    'Latest filtered messages:',
    'Latest filtered messages with reference:',
    'Latest filtered messages with gif:',
  ]);
  assert.ok(lines.includes('[11/12/2026, 12:00:01 PM] bob: reply <gif! cat> here (reference: a)'));
  assert.ok(lines.includes('[11/12/2026, 12:00:00 PM] alice: first message here (reference: null)'));
  assert.ok(lines.includes('[11/12/2026, 12:00:01 PM] bob: reply <gif! cat> here (has_gif: 1, reference: a)'));
  assert.ok(lines.includes('[11/12/2026, 12:00:01 PM] bob: reply <gif! cat> here (references: first message here)'));
  assert.ok(lines.includes('[11/12/2026, 12:00:01 PM] bob: reply <gif! cat> here (has_gif: 1)'));
});

test('opens the database read-only: a missing database is an error and is not created', (t) => {
  const dir = makeDir(t);
  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'messages.db')), false);
});

test('leaves the database unchanged', (t) => {
  const dir = makeDir(t);
  seed(dir);
  const file = path.join(dir, 'messages.db');
  const before = fs.readFileSync(file);
  assert.equal(run(dir).status, 0);
  assert.deepEqual(fs.readFileSync(file), before);
});
