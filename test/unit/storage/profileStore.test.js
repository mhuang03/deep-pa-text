import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, runMigrations } from '../../../src/storage/database.js';
import { createProfileStore } from '../../../src/storage/profileStore.js';

const setup = () => {
  const db = openDatabase(':memory:');
  return { db, store: createProfileStore({ db }) };
};

const bob = (overrides) => ({
  username: 'bob', userId: 'u1', displayName: 'Bob', avatarURL: 'https://a/1.png', observedAt: 100, ...overrides,
});

test('latest is null for an unknown user', () => {
  assert.equal(setup().store.latest('bob'), null);
});

test('latest returns the row with the greatest observed_at as a Profile', () => {
  const { store } = setup();
  store.record(bob({ observedAt: 200, displayName: 'Newer' }));
  store.record(bob({ observedAt: 100 }));
  assert.deepEqual(store.latest('bob'), {
    username: 'bob', userId: 'u1', displayName: 'Newer', avatarURL: 'https://a/1.png',
  });
});

test('null user id and avatar are stored and read back as null', () => {
  const { store } = setup();
  store.record(bob({ userId: undefined, avatarURL: null }));
  assert.deepEqual(store.latest('bob'), { username: 'bob', userId: null, displayName: 'Bob', avatarURL: null });
});

test('record is append-only: an existing observation is never overwritten', () => {
  const { store, db } = setup();
  store.record(bob());
  store.record(bob({ displayName: 'Changed' }));
  store.record(bob({ observedAt: 101, displayName: 'Later' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_profiles').get().n, 2);
  assert.equal(store.latest('bob').displayName, 'Later');
  assert.deepEqual(store.namesOf('bob'), ['Bob', 'Later']);
});

test('all returns the newest row per username', () => {
  const { store } = setup();
  store.record(bob({ observedAt: 1, displayName: 'Old' }));
  store.record(bob({ observedAt: 2, displayName: 'New' }));
  store.record(bob({ username: 'carol', userId: 'u2', displayName: 'Carol', observedAt: 1 }));
  assert.deepEqual(store.all().map((p) => [p.username, p.displayName]), [['bob', 'New'], ['carol', 'Carol']]);
});

test('namesOf lists each distinct display name once, oldest first', () => {
  const { store } = setup();
  store.record(bob({ observedAt: 1, displayName: 'A' }));
  store.record(bob({ observedAt: 2, displayName: 'B' }));
  store.record(bob({ observedAt: 3, displayName: 'A' }));
  assert.deepEqual(store.namesOf('bob'), ['A', 'B']);
  assert.deepEqual(store.namesOf('nobody'), []);
});

test('the migration is idempotent and leaves existing rows untouched', () => {
  const { store, db } = setup();
  store.record(bob());
  runMigrations(db);
  runMigrations(db);
  assert.equal(store.latest('bob').displayName, 'Bob');
});
