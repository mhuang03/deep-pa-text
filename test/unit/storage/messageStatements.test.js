import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { prepareStatements } from '../../../src/storage/messageStatements.js';

test('prepares every named statement once against the schema', () => {
  const statements = prepareStatements(openDatabase(':memory:'));
  const names = Object.keys(statements);
  assert.ok(names.length >= 20);
  names.forEach((name) => assert.equal(typeof statements[name].run, 'function', name));
  ['insertRaw', 'insertFiltered', 'markRaw', 'markCorpus', 'page', 'latestGif', 'newestRawVisible'].forEach((name) => {
    assert.ok(names.includes(name), name);
  });
});

test('the latest-row statements filter out deleted rows, and the gif one needs has_gif', () => {
  const db = openDatabase(':memory:');
  const statements = prepareStatements(db);
  const insert = db.prepare('INSERT INTO filtered_messages (id, author, content, timestamp, has_gif) VALUES (?, ?, ?, ?, ?)');
  insert.run('1', 'a', 'plain', 1, 0);
  insert.run('2', 'a', '<gif!x>', 2, 1);
  insert.run('3', 'a', '<gif!y>', 3, 1);
  db.exec("UPDATE filtered_messages SET deleted_at = 9 WHERE id = '3'");
  assert.deepEqual(statements.latestFiltered.all(10).map((r) => r.id), ['2', '1']);
  assert.deepEqual(statements.latestGif.all(10).map((r) => r.id), ['2']);
});
