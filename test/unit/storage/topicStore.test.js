import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../../../src/storage/database.js';
import { createTopicStore } from '../../../src/storage/topicStore.js';
import { MIGRATIONS } from '../../../src/storage/migrations.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';

const TOPIC_MIGRATIONS = 5;
const config = { storage: { inferredReferenceWindowMs: 3600000, chunkSize: 500 } };

const setup = () => {
  const db = openDatabase(':memory:');
  return { db, store: createTopicStore({ db }), messages: createMessageStore({ db, config }) };
};

const addMessage = (messages, id, author = 'alice', content = `message ${id} about camping`) => {
  messages.insertFiltered({ id, author, content, timestamp: 1000, reference: null }, { inferReference: false });
};

const topic = (overrides = {}) => ({
  buildId: 'b1',
  label: 'Camping trips',
  summary: 'They plan camping.',
  size: 20,
  authorCount: 2,
  cohesion: 0.8,
  medianTimestamp: 5000,
  authors: [{ author: 'alice', share: 0.6, newestTimestamp: 9 }, { author: 'bob', share: 0.4, newestTimestamp: 7 }],
  messages: ['m1', 'm2'],
  ...overrides,
});

const complete = (store, buildId, completedAt) => store.completeBuild({ buildId, completedAt, stats: { n: 1 } });

test('an empty bank has no build and no topics', () => {
  const { store } = setup();
  assert.equal(store.currentBuild(), null);
  assert.deepEqual(store.currentTopics(), []);
  assert.deepEqual([...store.hiddenLabelKeys()], []);
});

test('insertTopic stores the topic with its authors and returns a numeric id', () => {
  const { store } = setup();
  const id = store.insertTopic(topic());
  assert.equal(typeof id, 'number');
  complete(store, 'b1', 100);
  const [stored] = store.currentTopics();
  assert.deepEqual(stored, {
    id, label: 'Camping trips', summary: 'They plan camping.', size: 20, authorCount: 2, cohesion: 0.8,
    medianTimestamp: 5000,
    authors: [{ author: 'alice', share: 0.6, newestTimestamp: 9 }, { author: 'bob', share: 0.4, newestTimestamp: 7 }],
  });
});

test('completeBuild records the stats and currentBuild reports it', () => {
  const { store, db } = setup();
  store.completeBuild({ buildId: 'b1', completedAt: 100, stats: { labelled: 3 } });
  assert.deepEqual(store.currentBuild(), { buildId: 'b1', completedAt: 100 });
  assert.equal(JSON.parse(db.prepare('SELECT stats FROM topic_builds').get().stats).labelled, 3);
});

test('an interrupted build is ignored and the previous bank stays current', () => {
  const { store, db } = setup();
  store.insertTopic(topic({ buildId: 'old', label: 'Old topic' }));
  complete(store, 'old', 100);
  ['a', 'b', 'c'].forEach((label) => store.insertTopic(topic({ buildId: 'new', label })));
  assert.deepEqual(store.currentTopics().map((t) => t.label), ['Old topic']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topics').get().n, 4);
});

test('a second build replaces the first as the current bank and keeps the old rows', () => {
  const { store, db } = setup();
  store.insertTopic(topic({ buildId: 'old', label: 'Old topic' }));
  complete(store, 'old', 100);
  store.insertTopic(topic({ buildId: 'new', label: 'New topic' }));
  complete(store, 'new', 200);
  assert.deepEqual(store.currentTopics().map((t) => t.label), ['New topic']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topics').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic_builds').get().n, 2);
});

test('builds completed at the same instant are ordered by build id', () => {
  const { store } = setup();
  complete(store, 'b-1', 100);
  complete(store, 'b-2', 100);
  assert.equal(store.currentBuild().buildId, 'b-2');
});

test('completing the same build twice keeps the first row', () => {
  const { store } = setup();
  store.completeBuild({ buildId: 'b1', completedAt: 100, stats: { first: true } });
  store.completeBuild({ buildId: 'b1', completedAt: 999, stats: { first: false } });
  assert.equal(store.currentBuild().completedAt, 100);
});

test('insertTopic is one transaction: a failing author row leaves nothing behind', () => {
  const { store, db } = setup();
  const duplicate = { author: 'alice', share: 1, newestTimestamp: 1 };
  assert.throws(() => store.insertTopic(topic({ authors: [duplicate, duplicate] })));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topics').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic_authors').get().n, 0);
});

test('samplesOf returns the representatives in rank order, limited, joined to visible corpus rows', () => {
  const { store, messages } = setup();
  ['m1', 'm2', 'm3'].forEach((id, i) => addMessage(messages, id, i === 1 ? 'bob' : 'alice'));
  const id = store.insertTopic(topic({ messages: ['m3', 'm1', 'm2'] }));
  assert.deepEqual(store.samplesOf(id, 2), [
    { author: 'alice', text: 'message m3 about camping' },
    { author: 'alice', text: 'message m1 about camping' },
  ]);
  assert.equal(store.samplesOf(id, 10).length, 3);
});

test('a representative deleted after the build disappears from samplesOf', () => {
  const { store, messages } = setup();
  ['m1', 'm2'].forEach((id) => addMessage(messages, id));
  const id = store.insertTopic(topic());
  messages.softDelete('m1', 50);
  assert.deepEqual(store.samplesOf(id, 5).map((s) => s.text), ['message m2 about camping']);
  messages.softDelete('m2', 50);
  assert.deepEqual(store.samplesOf(id, 5), []);
});

test('hide sets the marker once, keeps the row and removes the topic from the current bank', () => {
  const { store, db } = setup();
  const id = store.insertTopic(topic());
  complete(store, 'b1', 100);
  assert.equal(store.hide(id, 500), true);
  assert.equal(store.hide(id, 900), false);
  assert.equal(store.hide(9999, 900), false);
  assert.deepEqual(store.currentTopics(), []);
  assert.equal(db.prepare('SELECT deleted_at FROM topics WHERE id = ?').get(id).deleted_at, 500);
});

test('hiddenLabelKeys holds the dedup keys of hidden topics of every build', () => {
  const { store } = setup();
  const a = store.insertTopic(topic({ buildId: 'old', label: 'Weekend Plans!' }));
  store.insertTopic(topic({ buildId: 'old', label: 'Visible one' }));
  complete(store, 'old', 100);
  store.hide(a, 1);
  complete(store, 'new', 200);
  assert.deepEqual([...store.hiddenLabelKeys()], ['weekend plans']);
});

test('the migrations are idempotent and leave existing topic rows untouched', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const store = createTopicStore({ db });
  store.insertTopic(topic());
  complete(store, 'b1', 100);
  const before = JSON.stringify(db.prepare('SELECT * FROM topics').all());
  runMigrations(db);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM topics').all()), before);
  assert.equal(store.currentTopics().length, 1);
});

test('a database created before the topic tables gains them without touching its rows', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS.slice(0, MIGRATIONS.length - TOPIC_MIGRATIONS));
  db.exec("INSERT INTO filtered_messages (id, author, content, timestamp, has_gif) VALUES ('1', 'a', 'old row', 5, 0)");
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  ['topic_builds', 'topics', 'topic_authors', 'topic_messages'].forEach((name) => assert.ok(tables.includes(name), name));
  assert.equal(db.prepare('SELECT content FROM filtered_messages').get().content, 'old row');
});
