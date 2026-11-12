import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';

const HOUR = 3600000;
const config = { storage: { inferredReferenceWindowMs: HOUR } };
const msg = (id, author, timestamp, extra = {}) => ({
  id, author, content: `content ${id}`, timestamp, reference: null, ...extra,
});

const setup = () => {
  const db = openDatabase(':memory:');
  return { db, store: createMessageStore({ db, config }) };
};
const refOf = (db, id) => db.prepare('SELECT reference FROM filtered_messages WHERE id = ?').get(id).reference;

test('insertRaw stores the raw record and is idempotent', () => {
  const { db, store } = setup();
  store.insertRaw(msg('1', 'a', 10, { content: '<@1> raw' }));
  store.insertRaw(msg('1', 'a', 10, { content: 'other' }));
  const rows = db.prepare('SELECT * FROM messages').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '<@1> raw');
});

test('insertFiltered returns the stored message with hasGif', () => {
  const { store } = setup();
  const gif = store.insertFiltered(msg('1', 'a', 10, { content: 'x <gif! cat>' }));
  const plain = store.insertFiltered(msg('2', 'a', 20));
  assert.equal(gif.hasGif, true);
  assert.equal(plain.hasGif, false);
  assert.equal(plain.id, '2');
});

test('stores has_gif as 1 or 0', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 10, { content: '<gif! cat>' }));
  store.insertFiltered(msg('2', 'a', 20));
  assert.equal(db.prepare("SELECT has_gif FROM filtered_messages WHERE id = '1'").get().has_gif, 1);
  assert.equal(db.prepare("SELECT has_gif FROM filtered_messages WHERE id = '2'").get().has_gif, 0);
});

test('insertFiltered is idempotent', () => {
  const { db, store } = setup();
  assert.ok(store.insertFiltered(msg('1', 'a', 10)));
  assert.equal(store.insertFiltered(msg('1', 'a', 10)), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM filtered_messages').get().n, 1);
});

test('a duplicate does not re-resolve a reference', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 10));
  store.insertFiltered(msg('2', 'b', 20));
  assert.equal(store.insertFiltered(msg('2', 'b', 20, { reference: '1' })), null);
  assert.equal(refOf(db, '2'), '1');
});

test('keeps an explicit reference to a stored message', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 10));
  const stored = store.insertFiltered(msg('2', 'b', 20, { reference: '1' }));
  assert.equal(stored.reference, '1');
  assert.equal(refOf(db, '2'), '1');
});

test('an unknown explicit reference falls through to the heuristic', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 10));
  store.insertFiltered(msg('2', 'b', 20, { reference: 'missing' }));
  assert.equal(refOf(db, '2'), '1');
});

test('an unknown explicit reference with no earlier message resolves to null', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('2', 'b', 20, { reference: 'missing' }));
  assert.equal(refOf(db, '2'), null);
});

test('heuristic infers the previous message by another author', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 10));
  store.insertFiltered(msg('2', 'b', 20));
  assert.equal(refOf(db, '2'), '1');
});

test('heuristic skips a previous message by the same author', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 10));
  store.insertFiltered(msg('2', 'a', 20));
  assert.equal(refOf(db, '2'), null);
});

test('heuristic window is strict', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 0));
  store.insertFiltered(msg('2', 'b', HOUR));
  store.insertFiltered(msg('3', 'c', HOUR + HOUR - 1));
  assert.equal(refOf(db, '2'), null);
  assert.equal(refOf(db, '3'), '2');
});

test('heuristic uses only strictly earlier timestamps', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 10));
  store.insertFiltered(msg('2', 'b', 10));
  assert.equal(refOf(db, '2'), null);
});

test('explicit references skip the author and window rules', () => {
  const { db, store } = setup();
  store.insertFiltered(msg('1', 'a', 0));
  store.insertFiltered(msg('2', 'a', 10 * HOUR, { reference: '1' }));
  assert.equal(refOf(db, '2'), '1');
});

const seedMany = (store, n, author = 'a') => {
  for (let i = 0; i < n; i += 1) store.insertFiltered(msg(`${author}${i}`, author, i * 10));
};

test('randomMessages respects author, before and limit and returns id and content', () => {
  const { store } = setup();
  seedMany(store, 10, 'a');
  seedMany(store, 5, 'b');
  assert.equal(store.randomMessages({ author: 'a', limit: 4 }).length, 4);
  const all = store.randomMessages({ author: 'a', limit: 100 });
  assert.equal(new Set(all.map((r) => r.id)).size, 10);
  assert.ok(all.every((r) => r.content === `content ${r.id}` && r.id.startsWith('a')));
  const before = store.randomMessages({ author: 'a', before: 30, limit: 100 });
  assert.deepEqual(new Set(before.map((r) => r.id)), new Set(['a0', 'a1', 'a2']));
});

test('randomMessages returns an empty array for an unknown author', () => {
  const { store } = setup();
  assert.deepEqual(store.randomMessages({ author: 'nobody', limit: 5 }), []);
});

test('countContents counts exact contents of the author before the cutoff', () => {
  const { store } = setup();
  [['1', 'a', 'lol', 10], ['2', 'a', 'lol', 20], ['3', 'a', 'LOL', 30], ['4', 'a', 'lol', 100],
    ['5', 'b', 'lol', 10], ['6', 'a', 'other', 10]].forEach(([id, author, content, timestamp]) => {
    store.insertFiltered(msg(id, author, timestamp, { content }));
  });
  const counts = store.countContents({ author: 'a', contents: ['lol', 'LOL', 'missing'], before: 100 });
  assert.deepEqual(Object.fromEntries(counts), { lol: 2, LOL: 1 });
});

test('countContents handles no contents and more than one chunk of contents', () => {
  const { store } = setup();
  assert.equal(store.countContents({ author: 'a', contents: [], before: 10 }).size, 0);
  const contents = Array.from({ length: 1100 }, (_, i) => `text ${i}`);
  [0, 600, 1099].forEach((i) => store.insertFiltered(msg(`c${i}`, 'a', i, { content: contents[i] })));
  const counts = store.countContents({ author: 'a', contents, before: 5000 });
  assert.deepEqual([...counts.keys()].sort(), ['text 0', 'text 1099', 'text 600']);
});

test('latest queries return newest first and honour the limit', () => {
  const { store } = setup();
  [1, 2, 3].forEach((n) => store.insertRaw(msg(`r${n}`, 'a', n)));
  store.insertFiltered(msg('f1', 'a', 1));
  store.insertFiltered(msg('f2', 'b', 2, { content: '<gif! x>' }));
  store.insertFiltered(msg('f3', 'c', 3, { reference: 'f2' }));
  assert.deepEqual(store.latestRaw(2).map((r) => r.id), ['r3', 'r2']);
  assert.deepEqual(store.latestFiltered(10).map((r) => r.id), ['f3', 'f2', 'f1']);
  assert.deepEqual(store.latestWithGif(10).map((r) => r.id), ['f2']);
  const withRef = store.latestWithReference(10);
  assert.deepEqual(withRef.map((r) => r.id), ['f3', 'f2']);
  assert.equal(withRef[0].reference_content, '<gif! x>');
});

test('getParents maps ids to the content of their stored parent', () => {
  const { store } = setup();
  store.insertFiltered(msg('p', 'a', 10, { content: 'parent <gif! x>' }));
  store.insertFiltered(msg('c', 'b', 20, { reference: 'p' }));
  store.insertFiltered(msg('lonely', 'a', 99 * HOUR));
  const parents = store.getParents(['c', 'lonely', 'unknown']);
  assert.deepEqual([...parents], [['c', { content: 'parent <gif! x>' }]]);
});

test('getParents ignores a reference to a missing parent', () => {
  const { store } = setup();
  store.insertFiltered(msg('c', 'b', 20, { reference: 'gone' }));
  assert.equal(store.getParents(['c']).size, 0);
});

test('getParents with no ids returns an empty map without touching the database', () => {
  const store = createMessageStore({
    db: { prepare: (sql) => { if (/IN \(/.test(sql)) throw new Error('queried'); return setup().db.prepare(sql); } },
    config,
  });
  assert.equal(store.getParents([]).size, 0);
});

test('getParents handles more than 500 ids in chunks', () => {
  const { store } = setup();
  store.insertFiltered(msg('p', 'a', 10, { content: 'the parent' }));
  const ids = [];
  for (let i = 0; i < 1100; i += 1) {
    ids.push(`c${i}`);
    store.insertFiltered(msg(`c${i}`, 'b', 20 + i, { reference: 'p' }));
  }
  const parents = store.getParents(ids);
  assert.equal(parents.size, 1100);
  assert.equal(parents.get('c1099').content, 'the parent');
});
