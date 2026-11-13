import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { prepareStatements } from '../../../src/storage/messageStatements.js';
import { createMessageEdits } from '../../../src/storage/messageEdits.js';
import { createMessageQueries } from '../../../src/storage/messageQueries.js';

const setup = (chunkSize = 2) => {
  const db = openDatabase(':memory:');
  const statements = prepareStatements(db);
  const edits = createMessageEdits({ db, statements, windowMs: 3600000 });
  const queries = createMessageQueries({ db, statements, chunkSize });
  return { db, edits, queries };
};
const rec = (id, author, timestamp, content = `text ${id}`, reference = null) => ({ id, author, content, timestamp, reference });
const add = (edits, record) => { edits.insertRaw(record); return edits.insertFiltered(record); };

test('pageFiltered pages by cursor with camel-cased rows', () => {
  const { edits, queries } = setup();
  ['1', '2', '3'].forEach((id, i) => add(edits, rec(id, 'a', 10 + i)));
  const first = queries.pageFiltered({ limit: 2 });
  assert.deepEqual(first.map((r) => r.id), ['1', '2']);
  assert.equal(first[0].hasGif, false);
  const next = queries.pageFiltered({ after: { timestamp: first[1].timestamp, id: first[1].id }, limit: 2 });
  assert.deepEqual(next.map((r) => r.id), ['3']);
});

test('getParents, hiddenIds and countContents work across chunks smaller than the input', () => {
  const { edits, queries } = setup(2);
  add(edits, rec('p1', 'a', 1, 'parent one'));
  add(edits, rec('p2', 'b', 2, 'parent two'));
  add(edits, rec('c1', 'c', 3, 'child', 'p1'));
  add(edits, rec('c2', 'c', 4, 'child', 'p2'));
  add(edits, rec('c3', 'c', 5, 'child', 'p1'));
  const parents = queries.getParents(['c1', 'c2', 'c3', 'missing']);
  assert.deepEqual([...parents].map(([id, p]) => [id, p.content]).sort(), [['c1', 'parent one'], ['c2', 'parent two'], ['c3', 'parent one']]);
  edits.softDelete('c2', 99);
  assert.deepEqual([...queries.hiddenIds(['c1', 'c2', 'nope', 'c2'])], ['c2']);
  const counts = queries.countContents({ author: 'c', contents: ['child', 'other', 'child', 'x'], before: 100 });
  assert.deepEqual([...counts], [['child', 2]]);
});

test('getRaw reports the newest revision and the deleted flag', () => {
  const { edits, queries } = setup();
  const record = rec('1', 'a', 1, 'original');
  add(edits, record);
  edits.applyEdit({ id: '1', content: 'revised', editedAt: 5, filtered: { ...record, content: 'revised' } });
  assert.equal(queries.getRaw('1').content, 'revised');
  assert.equal(queries.getRaw('1').deleted, false);
  edits.softDelete('1', 9);
  assert.equal(queries.getRaw('1').deleted, true);
  assert.equal(queries.getRaw('nope'), null);
});

test('newestRaw ignores deleted rows unless asked', () => {
  const { edits, queries } = setup();
  add(edits, rec('1', 'a', 1));
  add(edits, rec('2', 'a', 2));
  edits.softDelete('2', 9);
  assert.deepEqual(queries.newestRaw(), { id: '1', timestamp: 1 });
  assert.deepEqual(queries.newestRaw({ includeDeleted: true }), { id: '2', timestamp: 2 });
});

test('randomMessages, burstStats and the latest lists read through the prepared statements', () => {
  const { edits, queries } = setup();
  add(edits, rec('1', 'a', 1000));
  add(edits, rec('2', 'a', 1500));
  add(edits, rec('3', 'b', 90000));
  assert.deepEqual(queries.randomMessages({ author: 'a', limit: 10 }).map((r) => r.id).sort(), ['1', '2']);
  assert.deepEqual(queries.burstStats({ author: 'a', windowMs: 1000 }), { samples: 2, rate: 0.5 });
  assert.equal(queries.latestRaw(2).length, 2);
  assert.equal(queries.latestFiltered(10).length, 3);
  assert.equal(queries.latestWithGif(10).length, 0);
  assert.equal(queries.latestWithReference(10).length, 1);
  assert.equal(queries.randomStarters({ author: 'a', minGapMs: 1, limit: 5 }).length > 0, true);
});

test('previousRaw is the newest visible message at or before a time, other than the excluded one, with revisions', () => {
  const { edits, queries } = setup();
  add(edits, rec('1', 'a', 10, 'first'));
  add(edits, rec('2', 'b', 20, 'second'));
  add(edits, rec('3', 'c', 30, 'third'));
  assert.equal(queries.previousRaw({ before: 30, excludeId: '3' }).id, '2');
  assert.equal(queries.previousRaw({ before: 30, excludeId: 'other' }).id, '3');
  edits.softDelete('2', 99);
  assert.equal(queries.previousRaw({ before: 30, excludeId: '3' }).id, '1');
  edits.applyEdit({ id: '1', content: 'first, revised', editedAt: 50, filtered: { ...rec('1', 'a', 10), content: 'first, revised' } });
  assert.deepEqual(
    queries.previousRaw({ before: 25, excludeId: '3' }),
    { id: '1', author: 'a', content: 'first, revised', timestamp: 10, reference: null, deleted: false },
  );
  assert.equal(queries.previousRaw({ before: 5, excludeId: 'x' }), null);
});
