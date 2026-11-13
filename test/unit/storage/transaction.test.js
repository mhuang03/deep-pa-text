import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from '../../../src/storage/transaction.js';

const setup = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (n INTEGER)');
  return db;
};

test('commits and returns the result of the function', () => {
  const db = setup();
  const result = runInTransaction(db, () => {
    db.exec('INSERT INTO t VALUES (1)');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
});

test('rolls back and rethrows when the function throws', () => {
  const db = setup();
  assert.throws(() => runInTransaction(db, () => {
    db.exec('INSERT INTO t VALUES (1)');
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  assert.equal(db.isTransaction, false);
});
