import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, runMigrations } from '../../../src/storage/database.js';
import { createMetaStore } from '../../../src/storage/metaStore.js';

const setup = () => {
  const db = openDatabase(':memory:');
  return { db, store: createMetaStore({ db }) };
};

test('get is null for an unknown key', () => {
  assert.equal(setup().store.get('missing'), null);
});

test('setIfAbsent stores a value as a string and reports that it did', () => {
  const { store } = setup();
  assert.equal(store.setIfAbsent('started', 12), true);
  assert.equal(store.get('started'), '12');
});

test('setIfAbsent never overwrites an existing key', () => {
  const { store } = setup();
  store.setIfAbsent('chroma_generation', 'g1');
  assert.equal(store.setIfAbsent('chroma_generation', 'g2'), false);
  assert.equal(store.get('chroma_generation'), 'g1');
});

test('the meta migration is idempotent and keeps existing rows', () => {
  const { db, store } = setup();
  store.setIfAbsent('k', 'v');
  runMigrations(db);
  runMigrations(db);
  assert.equal(createMetaStore({ db }).get('k'), 'v');
});
