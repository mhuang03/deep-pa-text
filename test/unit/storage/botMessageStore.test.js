import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createBotMessageStore } from '../../../src/storage/botMessageStore.js';

const row = (id, timestamp, extra = {}) => ({
  id, persona: 'bob', content: `text ${id}`, timestamp, reference: null, trigger: 'auto', ...extra,
});

const setup = () => createBotMessageStore({ db: openDatabase(':memory:') });

test('inserts and reads a bot message by id', () => {
  const store = setup();
  store.insert(row('1', 10, { reference: 'x', trigger: 'command' }));
  assert.deepEqual(store.getById('1'), row('1', 10, { reference: 'x', trigger: 'command' }));
});

test('getById returns null for an unknown id', () => {
  assert.equal(setup().getById('nope'), null);
});

test('inserting an existing id keeps the original row', () => {
  const store = setup();
  store.insert(row('1', 10));
  store.insert(row('1', 99, { content: 'changed', persona: 'carol' }));
  assert.deepEqual(store.getById('1'), row('1', 10));
});

test('an undefined reference is stored as null', () => {
  const store = setup();
  const { reference, ...rest } = row('1', 10);
  store.insert(rest);
  assert.equal(store.getById('1').reference, null);
});

test('recent returns newest first and respects the limit', () => {
  const store = setup();
  [row('a', 1), row('b', 3), row('c', 2)].forEach(store.insert);
  assert.deepEqual(store.recent({ limit: 2 }).map((m) => m.id), ['b', 'c']);
  assert.deepEqual(store.recent({ limit: 10 }).map((m) => m.id), ['b', 'c', 'a']);
  assert.deepEqual(store.recent({ limit: 0 }), []);
});

test('rows with the same timestamp are ordered by id descending', () => {
  const store = setup();
  [row('a', 5), row('c', 5), row('b', 5)].forEach(store.insert);
  assert.deepEqual(store.recent({ limit: 3 }).map((m) => m.id), ['c', 'b', 'a']);
});

test('recent requires a limit', () => {
  const store = setup();
  assert.throws(() => store.recent({}), /limit/);
  assert.throws(() => store.recent(), /limit/);
});
