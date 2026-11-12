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
});
