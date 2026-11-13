import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../src/storage/database.js';
import { MIGRATIONS } from '../../../src/storage/migrations.js';
import { createInspector } from '../../../src/storage/inspector.js';

const T0 = 1000;

const seedCurrent = () => {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO messages (id, author, content, timestamp, reference) VALUES
      ('a', 'alice', 'first', ${T0}, NULL), ('b', 'bob', 'reply <gif! x>', ${T0 + 1}, 'a'), ('c', 'carol', 'gone', ${T0 + 2}, NULL);
    INSERT INTO filtered_messages (id, author, content, timestamp, reference, has_gif) VALUES
      ('a', 'alice', 'first', ${T0}, NULL, 0), ('b', 'bob', 'reply <gif! x>', ${T0 + 1}, 'a', 1), ('c', 'carol', 'gone', ${T0 + 2}, NULL, 0);
    UPDATE messages SET deleted_at = 5 WHERE id = 'c' AND deleted_at IS NULL;
    UPDATE filtered_messages SET deleted_at = 5 WHERE id = 'c' AND deleted_at IS NULL;
    INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger) VALUES ('x', 'bob', 'hi', ${T0 + 3}, NULL, 'revive');
  `);
  return db;
};

const seedLegacy = (statements) => {
  const db = new DatabaseSync(':memory:');
  statements.forEach((m) => db.exec(m.sql));
  db.exec(`
    INSERT INTO messages (id, author, content, timestamp, reference) VALUES ('a', 'alice', 'first', ${T0}, NULL), ('b', 'bob', 'second', ${T0 + 1}, 'a');
    INSERT INTO filtered_messages (id, author, content, timestamp, reference, has_gif) VALUES
      ('a', 'alice', 'first', ${T0}, NULL, 0), ('b', 'bob', 'second <gif! y>', ${T0 + 1}, 'a', 1);
  `);
  return db;
};

test('on the current schema it hides soft-deleted rows in every section', () => {
  const inspector = createInspector({ db: seedCurrent() });
  assert.deepEqual(inspector.latestRaw(10).rows.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(inspector.latestFiltered(10).rows.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(inspector.latestWithGif(10).rows.map((r) => r.id), ['b']);
  assert.deepEqual(inspector.latestWithReference(10).rows.map((r) => [r.id, r.reference_content]), [['b', 'first']]);
  assert.deepEqual(inspector.latestBot(10).rows.map((r) => r.author), ['bob [revive]']);
});

test('honours the limit', () => {
  assert.equal(createInspector({ db: seedCurrent() }).latestRaw(1).rows.length, 1);
});

test('on a legacy schema without deleted_at, source_id or bot_messages it reads without a visibility filter', () => {
  const inspector = createInspector({ db: seedLegacy(MIGRATIONS.slice(0, 3)) });
  assert.deepEqual(inspector.latestRaw(10).rows.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(inspector.latestFiltered(10).rows.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(inspector.latestWithGif(10).rows.map((r) => r.id), ['b']);
  assert.deepEqual(inspector.latestWithReference(10).rows.map((r) => [r.id, r.reference_content]), [['b', 'first']]);
  assert.deepEqual(inspector.latestBot(10), { missing: 'bot_messages' });
});

test('a missing table is reported by name', () => {
  const inspector = createInspector({ db: new DatabaseSync(':memory:') });
  assert.deepEqual(inspector.latestRaw(5), { missing: 'messages' });
  assert.deepEqual(inspector.latestFiltered(5), { missing: 'filtered_messages' });
  assert.deepEqual(inspector.latestWithReference(5), { missing: 'filtered_messages' });
  assert.deepEqual(inspector.latestWithGif(5), { missing: 'filtered_messages' });
  assert.deepEqual(inspector.latestBot(5), { missing: 'bot_messages' });
  assert.deepEqual(inspector.latestConversations(5), { missing: 'conversations' });
});

const seedConversations = () => {
  const db = seedCurrent();
  db.exec(`
    INSERT INTO conversations (id, started_at, topic_id, topic, premise, personas, turns) VALUES
      ('c1', ${T0 + 10}, 3, 'Old plans', 'p', '["alice","bob"]', '["alice","bob","alice"]'),
      ('c2', ${T0 + 20}, NULL, 'New plans', 'p', '["bob","carol"]', '["bob","carol","bob","carol"]');
    INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger, conversation_id, turn_index) VALUES
      ('t0', 'bob', 'one', ${T0 + 21}, NULL, 'conversation', 'c2', 0),
      ('t0b', 'bob', 'one more', ${T0 + 22}, NULL, 'conversation', 'c2', 0),
      ('t1', 'carol', 'two', ${T0 + 23}, 't0', 'conversation', 'c2', 1),
      ('gone', 'bob', 'three', ${T0 + 24}, 't1', 'conversation', 'c2', 2);
    UPDATE bot_messages SET deleted_at = 9 WHERE id = 'gone' AND deleted_at IS NULL;
  `);
  return db;
};

test('lists the latest conversations with planned and delivered turn counts, a burst counting once', () => {
  const { rows } = createInspector({ db: seedConversations() }).latestConversations(10);
  assert.deepEqual(rows, [
    { id: 'c2', timestamp: T0 + 20, topic: 'New plans', personas: ['bob', 'carol'], planned: 4, delivered: 2 },
    { id: 'c1', timestamp: T0 + 10, topic: 'Old plans', personas: ['alice', 'bob'], planned: 3, delivered: 0 },
  ]);
});

test('conversations honour the limit', () => {
  assert.deepEqual(createInspector({ db: seedConversations() }).latestConversations(1).rows.map((r) => r.id), ['c2']);
});

test('conversations are tolerant of a bot_messages table without the conversation columns', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS[3].sql);
  db.exec(MIGRATIONS.find((m) => m.sql?.includes('CREATE TABLE IF NOT EXISTS conversations')).sql);
  db.exec(`INSERT INTO conversations (id, started_at, topic, premise, personas, turns) VALUES ('c1', 5, 'T', 'p', '["a","b"]', '["a","b","a"]')`);
  assert.deepEqual(createInspector({ db }).latestConversations(5).rows.map((r) => [r.id, r.planned, r.delivered]), [['c1', 3, 0]]);
});

test('conversations are tolerant of a missing bot_messages table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS.find((m) => m.sql?.includes('CREATE TABLE IF NOT EXISTS conversations')).sql);
  db.exec(`INSERT INTO conversations (id, started_at, topic, premise, personas, turns) VALUES ('c1', 5, 'T', 'p', '["a","b"]', '["a","b"]')`);
  assert.equal(createInspector({ db }).latestConversations(5).rows[0].delivered, 0);
});
