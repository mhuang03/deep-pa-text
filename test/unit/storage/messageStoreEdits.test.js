import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';

const HOUR = 3600000;
const config = { storage: { inferredReferenceWindowMs: HOUR, chunkSize: 500 } };
const msg = (id, author, timestamp, extra = {}) => ({
  id, author, content: `content ${id}`, timestamp, reference: null, ...extra,
});

const setup = () => {
  const db = openDatabase(':memory:');
  return { db, store: createMessageStore({ db, config }) };
};
const add = (store, record, options) => {
  store.insertRaw(record);
  return store.insertFiltered(record, options);
};
const rows = (db, table = 'filtered_messages') => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));
const edit = (store, id, content, editedAt, original, extra = {}) => store.applyEdit({
  id, content, editedAt, filtered: { ...original, content }, ...extra,
});

test('softDelete marks the raw and every corpus row of the logical id, once', () => {
  const { db, store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  edit(store, '1', 'new text', 50, original);
  assert.equal(store.softDelete('1', 100), true);
  assert.deepEqual(rows(db).map((r) => r.deleted_at), [50, 100]);
  assert.equal(rows(db, 'messages')[0].deleted_at, 100);
  assert.equal(store.softDelete('1', 200), false);
  assert.equal(rows(db, 'messages')[0].deleted_at, 100);
});

test('softDelete of an unknown id marks nothing and does not throw', () => {
  assert.equal(setup().store.softDelete('nope', 5), false);
});

test('softDelete keeps every row', () => {
  const { db, store } = setup();
  add(store, msg('1', 'a', 10));
  store.softDelete('1', 5);
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db, 'messages').length, 1);
  assert.equal(rows(db)[0].content, 'content 1');
});

test('applyEdit appends a revision, hides the old row and adds a new row under a new id', () => {
  const { db, store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  const stored = edit(store, '1', 'see you at 6', 50, original);
  assert.equal(stored.id, '1:50');
  assert.equal(stored.content, 'see you at 6');
  assert.deepEqual(rows(db, 'message_revisions'), [{ message_id: '1', content: 'see you at 6', edited_at: 50 }]);
  const [old, fresh] = rows(db);
  assert.equal(old.id, '1');
  assert.equal(old.deleted_at, 50);
  assert.equal(old.content, 'content 1');
  assert.equal(fresh.id, '1:50');
  assert.equal(fresh.source_id, '1');
  assert.equal(fresh.timestamp, 10);
  assert.equal(fresh.deleted_at, null);
  assert.equal(rows(db, 'messages')[0].content, 'content 1');
});

test('applyEdit with a null filtered record hides the old row and adds none', () => {
  const { db, store } = setup();
  add(store, msg('1', 'a', 10));
  assert.equal(store.applyEdit({ id: '1', content: 'http://x.test', editedAt: 5, filtered: null }), null);
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].deleted_at, 5);
  assert.equal(rows(db, 'message_revisions').length, 1);
});

test('a second edit hides the first edit row too', () => {
  const { db, store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  edit(store, '1', 'two', 20, original);
  edit(store, '1', 'three', 30, original);
  assert.deepEqual(rows(db).map((r) => [r.id, r.deleted_at]), [['1', 20], ['1:20', 30], ['1:30', null]]);
  assert.equal(rows(db, 'message_revisions').length, 2);
});

test('the same edit twice is a no-op returning null', () => {
  const { db, store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  assert.ok(edit(store, '1', 'two', 20, original));
  assert.equal(edit(store, '1', 'two', 20, original), null);
  assert.equal(rows(db).length, 2);
  assert.equal(rows(db, 'message_revisions').length, 1);
});

test('applyEdit rolls everything back when the corpus insert fails', () => {
  const { db, store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  assert.throws(() => store.applyEdit({
    id: '1', content: 'x', editedAt: 20, filtered: { ...original, content: null },
  }));
  assert.equal(rows(db, 'message_revisions').length, 0);
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].deleted_at, null);
  assert.ok(edit(store, '1', 'ok', 30, original), 'the connection is usable after a rollback');
});

test('getRaw returns the newest revision content and the deleted flag', () => {
  const { store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  assert.equal(store.getRaw('1').content, 'content 1');
  edit(store, '1', 'two', 20, original);
  edit(store, '1', 'three', 30, original);
  assert.equal(store.getRaw('1').content, 'three');
  assert.equal(store.getRaw('1').deleted, false);
  store.softDelete('1', 40);
  assert.equal(store.getRaw('1').deleted, true);
});

test('hiddenIds returns existing invisible row ids and ignores unknown ids', () => {
  const { store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  add(store, msg('2', 'a', 20));
  edit(store, '1', 'two', 30, original);
  assert.deepEqual([...store.hiddenIds(['1', '1:30', '2', 'unknown'])], ['1']);
  assert.deepEqual([...store.hiddenIds([])], []);
});

test('hiddenIds works across chunk boundaries', () => {
  const { store } = setup();
  const ids = Array.from({ length: 1200 }, (_, i) => `m${i}`);
  ids.forEach((id, i) => add(store, msg(id, 'a', i)));
  store.softDelete('m1100', 5);
  assert.deepEqual([...store.hiddenIds(ids)], ['m1100']);
});

test('an explicit reference is kept when the logical message is visible, including after an edit', () => {
  const { db, store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  edit(store, '1', 'two', 20, original);
  add(store, msg('2', 'b', 30, { reference: '1' }), { inferReference: false });
  assert.equal(rows(db).find((r) => r.id === '2').reference, '1');
});

test('an explicit reference to a deleted message falls back to the previous visible message', () => {
  const { db, store } = setup();
  add(store, msg('1', 'a', 10));
  add(store, msg('2', 'c', 20));
  store.softDelete('2', 25);
  add(store, msg('3', 'b', 30, { reference: '2' }));
  assert.equal(rows(db).find((r) => r.id === '3').reference, '1');
});

test('inference skips deleted rows and stores the logical id of an edit row', () => {
  const { db, store } = setup();
  const original = msg('1', 'a', 10);
  add(store, original);
  edit(store, '1', 'two', 20, original);
  add(store, msg('2', 'b', 30));
  assert.equal(rows(db).find((r) => r.id === '2').reference, '1');
  store.softDelete('1', 35);
  add(store, msg('3', 'c', 40), { inferReference: true });
  assert.equal(rows(db).find((r) => r.id === '3').reference, '2');
});

test('getParents returns the visible row content of the referenced logical message', () => {
  const { store } = setup();
  const parent = msg('1', 'a', 10);
  add(store, parent);
  add(store, msg('2', 'b', 20, { reference: '1' }));
  assert.equal(store.getParents(['2']).get('2').content, 'content 1');
  edit(store, '1', 'edited parent', 30, parent);
  assert.equal(store.getParents(['2']).get('2').content, 'edited parent');
  store.softDelete('1', 40);
  assert.equal(store.getParents(['2']).has('2'), false);
});

test('corpus reads exclude invisible rows', () => {
  const { store } = setup();
  const original = msg('1', 'a', 10, { content: 'same words here' });
  add(store, original);
  add(store, msg('2', 'a', 20, { content: 'same words here' }));
  add(store, msg('3', 'a', 30, { content: 'gone <gif! x>' }));
  store.softDelete('3', 40);
  assert.deepEqual(store.randomMessages({ author: 'a', limit: 10 }).map((r) => r.id).sort(), ['1', '2']);
  assert.equal(store.countContents({ author: 'a', contents: ['same words here'], before: 100 }).get('same words here'), 2);
  assert.equal(store.countContents({ author: 'a', contents: ['gone <gif! x>'], before: 100 }).size, 0);
  assert.deepEqual(store.latestFiltered(10).map((r) => r.id).sort(), ['1', '2']);
  assert.deepEqual(store.latestRaw(10).map((r) => r.id).sort(), ['1', '2']);
  assert.deepEqual(store.latestWithGif(10), []);
});

test('latestWithReference needs a visible parent', () => {
  const { store } = setup();
  add(store, msg('1', 'a', 10));
  add(store, msg('2', 'b', 20, { reference: '1' }));
  assert.equal(store.latestWithReference(5).length, 1);
  store.softDelete('1', 30);
  assert.equal(store.latestWithReference(5).length, 0);
});

test('randomStarters shows an edited message by its new text and drops deleted ones', () => {
  const { store } = setup();
  const original = msg('1', 'a', 0);
  add(store, original);
  add(store, msg('2', 'a', 5 * HOUR));
  edit(store, '2', 'edited starter', 6 * HOUR, msg('2', 'a', 5 * HOUR));
  const starters = () => store.randomStarters({ author: 'a', minGapMs: HOUR, limit: 10 }).sort();
  assert.deepEqual(starters(), ['content 1', 'edited starter']);
  store.softDelete('1', 7 * HOUR);
  assert.deepEqual(starters(), ['edited starter']);
});

test('a deleted message is not a neighbour for randomStarters or burstStats', () => {
  const { store } = setup();
  add(store, msg('1', 'a', 0));
  add(store, msg('2', 'b', 1000));
  add(store, msg('3', 'a', 1000 + 3 * HOUR));
  assert.deepEqual(store.randomStarters({ author: 'a', minGapMs: HOUR, limit: 10 }).sort(), ['content 1', 'content 3']);
  store.softDelete('2', 5);
  assert.deepEqual(store.randomStarters({ author: 'a', minGapMs: HOUR, limit: 10 }).sort(), ['content 1', 'content 3']);
  store.softDelete('1', 6);
  assert.deepEqual(store.randomStarters({ author: 'a', minGapMs: HOUR, limit: 10 }), ['content 3']);
  assert.equal(store.burstStats({ author: 'a', windowMs: HOUR }).samples, 1);
});

test('a starter after a deleted message becomes a starter when its neighbour disappears', () => {
  const { store } = setup();
  add(store, msg('1', 'a', 0));
  add(store, msg('2', 'b', HOUR / 2));
  add(store, msg('3', 'a', HOUR / 2 + HOUR * 2));
  store.softDelete('2', 9);
  store.softDelete('3', 9);
  add(store, msg('4', 'b', HOUR * 5));
  assert.deepEqual(store.randomStarters({ author: 'b', minGapMs: HOUR, limit: 10 }), ['content 4']);
});

test('a message that entered the corpus through an edit gets an anchor row, so replies keep their reference', () => {
  const { db, store } = setup();
  store.insertRaw(msg('1', 'a', 10, { content: 'https://example.com' }));
  const stored = store.applyEdit({
    id: '1', content: 'finally got it working', editedAt: 20, filtered: msg('1', 'a', 10, { content: 'finally got it working' }),
  });
  assert.equal(stored.id, '1');
  const [anchor] = rows(db);
  assert.equal(anchor.id, '1');
  assert.equal(anchor.source_id, null);
  const reply = add(store, msg('2', 'b', 30, { reference: '1' }));
  assert.equal(reply.reference, '1');
  assert.equal(rows(db).find((r) => r.id === '2').reference, '1');
  edit(store, '1', 'second edit', 40, msg('1', 'a', 10));
  const all = rows(db);
  assert.equal(all.find((r) => r.id === '1:40').source_id, '1');
  assert.equal(all.find((r) => r.id === '1').deleted_at, 40);
});

test('an edit keeps the reference of the previous corpus row and never infers one', () => {
  const { db, store } = setup();
  add(store, msg('1', 'a', 10));
  add(store, msg('2', 'b', 20));
  add(store, msg('3', 'a', 30, { reference: '1' }), { inferReference: false });
  add(store, msg('4', 'b', 40), { inferReference: false });
  edit(store, '3', 'changed', 50, msg('3', 'a', 30, { reference: '2' }));
  edit(store, '4', 'changed', 60, msg('4', 'b', 40));
  const byId = Object.fromEntries(rows(db).map((r) => [r.id, r]));
  assert.equal(byId['3:50'].reference, '1');
  assert.equal(byId['4:60'].reference, null);
});

test('an edit of a message that never had a corpus row keeps a resolvable explicit reference only', () => {
  const { db, store } = setup();
  add(store, msg('1', 'a', 10));
  store.insertRaw(msg('2', 'b', 20));
  edit(store, '2', 'kept now', 30, msg('2', 'b', 20, { reference: '1' }));
  store.insertRaw(msg('3', 'b', 40));
  edit(store, '3', 'kept too', 50, msg('3', 'b', 40, { reference: 'ghost' }));
  const byId = Object.fromEntries(rows(db).map((r) => [r.id, r]));
  assert.equal(byId['2'].reference, '1');
  assert.equal(byId['3'].reference, null);
});
