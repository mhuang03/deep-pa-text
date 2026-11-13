import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../../../src/storage/database.js';
import { createConversationStore } from '../../../src/storage/conversationStore.js';

const plan = (id, extra = {}) => ({
  id, topicId: 7, topic: 'Weekend plans', premise: 'Someone floats a hike.', personas: ['alice', 'bob'],
  turns: ['alice', 'bob', 'alice'], ...extra,
});

const setup = () => createConversationStore({ db: openDatabase(':memory:') });

test('inserts a plan and reads it back with its personas and planned turns as lists', () => {
  const store = setup();
  store.insert(plan('c1'), 500);
  assert.deepEqual(store.getById('c1'), {
    id: 'c1', startedAt: 500, topicId: 7, topic: 'Weekend plans', premise: 'Someone floats a hike.',
    personas: ['alice', 'bob'], turns: ['alice', 'bob', 'alice'],
  });
});

test('a neighbourhood topic is stored with a null topic id', () => {
  const store = setup();
  store.insert(plan('c1', { topicId: null }), 1);
  assert.equal(store.getById('c1').topicId, null);
  assert.equal(store.recent({ limit: 1 })[0].topicId, null);
});

test('getById returns null for an unknown id', () => {
  assert.equal(setup().getById('nope'), null);
});

test('inserting an existing id keeps the original row', () => {
  const store = setup();
  store.insert(plan('c1'), 10);
  store.insert(plan('c1', { topic: 'Changed', personas: ['carol'] }), 99);
  assert.equal(store.getById('c1').topic, 'Weekend plans');
  assert.equal(store.getById('c1').startedAt, 10);
  assert.deepEqual(store.getById('c1').personas, ['alice', 'bob']);
});

test('recent returns summaries newest first, ties by id, and respects the limit', () => {
  const store = setup();
  store.insert(plan('a', { topic: 'A' }), 1);
  store.insert(plan('b', { topic: 'B' }), 3);
  store.insert(plan('c', { topic: 'C' }), 3);
  assert.deepEqual(store.recent({ limit: 2 }), [
    { id: 'c', startedAt: 3, topicId: 7, topic: 'C' },
    { id: 'b', startedAt: 3, topicId: 7, topic: 'B' },
  ]);
  assert.equal(store.recent({ limit: 10 }).length, 3);
  assert.deepEqual(store.recent({ limit: 0 }), []);
});

test('recent requires a non-negative integer limit', () => {
  const store = setup();
  assert.throws(() => store.recent({}), /limit/);
  assert.throws(() => store.recent({ limit: -1 }), /limit/);
  assert.throws(() => store.recent({ limit: 1.5 }), /limit/);
});

test('the table is created by the additive migrations and survives running them twice on an older database', () => {
  const db = new DatabaseSync(':memory:');
  // A bot_messages table from before conversations existed; the older tables are not needed here.
  db.exec('CREATE TABLE bot_messages (id TEXT PRIMARY KEY, persona TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL, reference TEXT, trigger TEXT NOT NULL)');
  db.exec("INSERT INTO bot_messages VALUES ('x', 'bob', 'old row', 1, NULL, 'auto')");
  runMigrations(db);
  runMigrations(db);
  assert.equal(db.prepare('SELECT content, conversation_id, turn_index FROM bot_messages').get().content, 'old row');
  assert.equal(db.prepare('SELECT conversation_id FROM bot_messages').get().conversation_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
});
