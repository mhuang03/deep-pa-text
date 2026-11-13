import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../../src/storage/database.js';
import { createTopicStore } from '../../../src/storage/topicStore.js';

const script = new URL('../../../scripts/topics.js', import.meta.url).pathname;

const makeDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-topics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const run = (dir, args, env = {}) => spawnSync(process.execPath, ['--no-warnings', script, ...args], {
  cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 20000,
});

const seedBank = (dir) => {
  const db = openDatabase(path.join(dir, 'messages.db'));
  const store = createTopicStore({ db });
  const id = store.insertTopic({
    buildId: 'b1', label: 'Camping trips', summary: 'They plan camping.', size: 20, authorCount: 2, cohesion: 0.8,
    medianTimestamp: Date.parse('2026-01-02T12:00:00Z'),
    authors: [{ author: 'alice', share: 0.75, newestTimestamp: 5 }, { author: 'bob', share: 0.25, newestTimestamp: 4 }],
    messages: [],
  });
  store.completeBuild({ buildId: 'b1', completedAt: 10, stats: {} });
  db.close();
  return id;
};

test('an unknown option exits 2 with the usage and touches nothing', (t) => {
  const dir = makeDir(t);
  const result = run(dir, ['--bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: npm run topics/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('invalid and conflicting options exit 2', (t) => {
  const dir = makeDir(t);
  ['--max-messages=0', '--list --hide 1', '--hide abc'].forEach((args) => {
    assert.equal(run(dir, args.split(' ')).status, 2, args);
  });
});

test('--list on a database without the tables prints an empty bank and needs no keys', (t) => {
  const dir = makeDir(t);
  const result = run(dir, ['--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Topic bank is empty/);
});

test('--list prints the current topics with their authors and summary', (t) => {
  const dir = makeDir(t);
  const id = seedBank(dir);
  const result = run(dir, ['--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`#${id} Camping trips \\(20 messages`));
  assert.match(result.stdout, /alice 75%, bob 25%/);
  assert.match(result.stdout, /They plan camping\./);
});

test('--hide hides one topic, reports whether it was found, and keeps the row', (t) => {
  const dir = makeDir(t);
  const id = seedBank(dir);
  assert.match(run(dir, ['--hide', String(id)]).stdout, /is hidden/);
  assert.match(run(dir, ['--hide', String(id)]).stdout, /not found or is already hidden/);
  assert.match(run(dir, ['--list']).stdout, /0 topics/);
  const db = openDatabase(path.join(dir, 'messages.db'));
  assert.notEqual(db.prepare('SELECT deleted_at FROM topics WHERE id = ?').get(id).deleted_at, null);
  db.close();
});

test('a build without keys names the missing variables, and a dry run needs only the embedding key', (t) => {
  const dir = makeDir(t);
  assert.match(run(dir, []).stderr, /: DEEPSEEK_API_KEY, OPENAI_API_KEY\. Set/);
  assert.match(run(dir, ['--dry-run']).stderr, /: OPENAI_API_KEY\. Set/);
  assert.equal(run(dir, []).status, 1);
});
