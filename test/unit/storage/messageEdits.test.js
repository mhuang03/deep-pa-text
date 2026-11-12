import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { prepareStatements } from '../../../src/storage/messageStatements.js';
import { createMessageEdits } from '../../../src/storage/messageEdits.js';

const HOUR = 3600000;
const setup = () => {
  const db = openDatabase(':memory:');
  return { db, edits: createMessageEdits({ db, statements: prepareStatements(db), windowMs: HOUR }) };
};
const rec = (id, author, timestamp, extra = {}) => ({ id, author, content: `text ${id}`, timestamp, reference: null, ...extra });

test('insertRaw reports whether a row was added and never overwrites', () => {
  const { edits, db } = setup();
  assert.equal(edits.insertRaw(rec('1', 'a', 1)), true);
  assert.equal(edits.insertRaw({ ...rec('1', 'a', 1), content: 'changed' }), false);
  assert.equal(db.prepare('SELECT content FROM messages').get().content, 'text 1');
  assert.equal(edits.hasRaw('1'), true);
  assert.equal(edits.hasRaw('2'), false);
});

test('insertFiltered infers a reference to the previous other author inside the window', () => {
  const { edits } = setup();
  edits.insertFiltered(rec('1', 'a', 1000));
  assert.equal(edits.insertFiltered(rec('2', 'b', 2000)).reference, '1');
  assert.equal(edits.insertFiltered(rec('3', 'b', 3000)).reference, null);
  assert.equal(edits.insertFiltered(rec('4', 'a', 3000 + HOUR + 1)).reference, null);
});

test('inferReference: false skips the inference and an explicit reference still resolves', () => {
  const { edits } = setup();
  edits.insertFiltered(rec('1', 'a', 1000));
  assert.equal(edits.insertFiltered(rec('2', 'b', 2000), { inferReference: false }).reference, null);
  assert.equal(edits.insertFiltered(rec('3', 'c', 3000, { reference: '1' }), { inferReference: false }).reference, '1');
  assert.equal(edits.insertFiltered(rec('4', 'c', 4000, { reference: 'unknown' }), { inferReference: false }).reference, null);
});

test('a duplicate corpus id inserts nothing and returns null; has_gif follows the token', () => {
  const { edits } = setup();
  assert.equal(edits.insertFiltered({ ...rec('1', 'a', 1), content: '<gif!cat>' }).hasGif, true);
  assert.equal(edits.insertFiltered(rec('1', 'a', 1)), null);
});

test('applyEdit hides the old rows and adds a revision row that keeps the reference', () => {
  const { edits, db } = setup();
  edits.insertFiltered(rec('1', 'a', 1000));
  edits.insertFiltered(rec('2', 'b', 2000));
  const stored = edits.applyEdit({ id: '2', content: 'edited text', editedAt: 5000, filtered: rec('2', 'b', 2000, { content: 'edited text' }) });
  assert.equal(stored.id, '2:5000');
  assert.equal(stored.reference, '1');
  const visible = db.prepare('SELECT id FROM filtered_messages WHERE deleted_at IS NULL ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(visible, ['1', '2:5000']);
  assert.equal(edits.applyEdit({ id: '2', content: 'edited text', editedAt: 5000, filtered: null }), null);
});

test('an edit that no longer passes the filter only hides the old rows', () => {
  const { edits, db } = setup();
  edits.insertFiltered(rec('1', 'a', 1000));
  assert.equal(edits.applyEdit({ id: '1', content: 'x', editedAt: 5000, filtered: null }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM filtered_messages WHERE deleted_at IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_revisions').get().n, 1);
});

test('softDelete marks rows once and reports whether anything changed', () => {
  const { edits } = setup();
  edits.insertRaw(rec('1', 'a', 1));
  edits.insertFiltered(rec('1', 'a', 1));
  assert.equal(edits.softDelete('1', 50), true);
  assert.equal(edits.softDelete('1', 60), false);
  assert.equal(edits.softDelete('unknown', 60), false);
});

test('transaction commits on success and rolls back everything on a throw', () => {
  const { edits, db } = setup();
  assert.equal(edits.transaction(() => edits.insertRaw(rec('1', 'a', 1))), true);
  assert.throws(() => edits.transaction(() => { edits.insertRaw(rec('2', 'a', 2)); throw new Error('abort'); }), /abort/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});
