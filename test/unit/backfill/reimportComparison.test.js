import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compareArchives } from '../../../src/backfill/reimportComparison.js';
import { createArchiveReader } from '../../../src/backfill/archiveReader.js';

const archiveOf = (rows) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)');
  rows.forEach(([id, content]) => db.prepare('INSERT INTO messages VALUES (?, ?)').run(id, content));
  return createArchiveReader({ db });
};

const storeOf = (map) => ({ getRaw: (id) => (map.has(id) ? { content: map.get(id) } : null) });

test('counts rows that are missing or changed in the new database', () => {
  const oldArchive = archiveOf([['1', 'a'], ['2', 'b'], ['3', 'c']]);
  const newArchive = archiveOf([['1', 'a'], ['2', 'B']]);
  const result = compareArchives({
    oldArchive, newArchive, messageStore: storeOf(new Map([['1', 'a'], ['2', 'B']])), pageSize: 10,
  });
  assert.equal(result.missingInNew, 1);
  assert.equal(result.changedContent, 1);
  assert.deepEqual(result.old, { raw: 3, corpus: 0, botMessages: 0 });
  assert.deepEqual(result.new, { raw: 2, corpus: 0, botMessages: 0 });
});

test('pages through the old archive in pageSize steps and visits every row once', () => {
  const rows = Array.from({ length: 7 }, (_, i) => [String(i + 10), `m${i}`]);
  const requested = [];
  const base = archiveOf(rows);
  const oldArchive = { ...base, rawPage: (options) => { requested.push(options); return base.rawPage(options); } };
  const seen = [];
  const messageStore = { getRaw: (id) => { seen.push(id); return { content: `m${Number(id) - 10}` }; } };
  const result = compareArchives({ oldArchive, newArchive: archiveOf([]), messageStore, pageSize: 3 });
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual(requested.map((r) => r.limit), [3, 3, 3, 3]);
  assert.equal(requested[0].afterId, null);
  assert.equal(requested[1].afterId, '12');
  assert.equal(result.missingInNew + result.changedContent, 0);
});

test('an archive without tables compares as empty', () => {
  const empty = createArchiveReader({ db: new DatabaseSync(':memory:') });
  const result = compareArchives({ oldArchive: empty, newArchive: empty, messageStore: storeOf(new Map()), pageSize: 5 });
  assert.deepEqual(result, {
    old: { raw: 0, corpus: 0, botMessages: 0 }, new: { raw: 0, corpus: 0, botMessages: 0 }, missingInNew: 0, changedContent: 0,
  });
});
