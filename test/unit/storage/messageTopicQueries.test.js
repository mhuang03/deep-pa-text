import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createMessageTopicQueries } from '../../../src/storage/messageTopicQueries.js';
import { createBotMessageStore } from '../../../src/storage/botMessageStore.js';

const HOUR = 3600000;
const config = { storage: { inferredReferenceWindowMs: HOUR, chunkSize: 500 }, burst: { siblingWindowMs: 1000 } };

const setup = () => {
  const db = openDatabase(':memory:');
  return { store: createMessageStore({ db, config }), bots: createBotMessageStore({ db, config }) };
};

const add = (store, id, { author = 'alice', content = `long enough message number ${id}`, timestamp = 1000 } = {}) => {
  const record = { id, author, content, timestamp, reference: null };
  store.insertRaw(record);
  store.insertFiltered(record, { inferReference: false });
};

const ids = (rows) => rows.map((row) => row.id).sort();

test('topicSample returns recent and older rows separately limited, with id, author, content and timestamp', () => {
  const { store } = setup();
  ['r1', 'r2', 'r3'].forEach((id) => add(store, id, { timestamp: 5000 }));
  ['o1', 'o2', 'o3'].forEach((id) => add(store, id, { timestamp: 100 }));
  const rows = store.topicSample({ minChars: 5, sinceMs: 1000, recentLimit: 2, olderLimit: 1 });
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.timestamp >= 1000).length, 2);
  assert.equal(rows.filter((row) => row.timestamp < 1000).length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['author', 'content', 'id', 'timestamp']);
});

test('topicSample puts a row at the cut-off in the recent group', () => {
  const { store } = setup();
  add(store, 'edge', { timestamp: 1000 });
  assert.equal(store.topicSample({ minChars: 5, sinceMs: 1000, recentLimit: 5, olderLimit: 0 }).length, 1);
  assert.equal(store.topicSample({ minChars: 5, sinceMs: 1000, recentLimit: 0, olderLimit: 5 }).length, 0);
});

test('topicSample and randomCorpus skip short and deleted rows', () => {
  const { store } = setup();
  add(store, 'keep', { content: 'x'.repeat(25) });
  add(store, 'short', { content: 'x'.repeat(24) });
  add(store, 'gone');
  store.softDelete('gone', 9);
  assert.deepEqual(ids(store.topicSample({ minChars: 25, sinceMs: 0, recentLimit: 10, olderLimit: 10 })), ['keep']);
  assert.deepEqual(ids(store.randomCorpus({ minChars: 25, limit: 10 })), ['keep']);
});

test('an edited message is sampled once, as its newest content', () => {
  const { store } = setup();
  add(store, 'e1', { content: 'the first version of the text' });
  store.applyEdit({
    id: 'e1', content: 'the edited version of the text', editedAt: 2000,
    filtered: { id: 'e1', author: 'alice', content: 'the edited version of the text', timestamp: 1000, reference: null },
  });
  const rows = store.randomCorpus({ minChars: 5, limit: 10 });
  assert.deepEqual(rows.map((row) => row.content), ['the edited version of the text']);
});

test('randomCorpus returns rows of any author up to the limit', () => {
  const { store } = setup();
  add(store, 'a', { author: 'alice' });
  add(store, 'b', { author: 'bob' });
  add(store, 'c', { author: 'carol' });
  const rows = store.randomCorpus({ minChars: 5, limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(store.randomCorpus({ minChars: 5, limit: 10 }).length, 3);
});

test('randomStartersAll returns the starters of every author with the starter gap rule', () => {
  const { store, bots } = setup();
  add(store, '1', { author: 'alice', timestamp: 0 });
  add(store, '2', { author: 'bob', timestamp: 5 * HOUR });
  add(store, '3', { author: 'carol', timestamp: 5 * HOUR + 60000 });
  bots.insert({ id: 'b1', persona: 'a', content: 'revive', timestamp: 10 * HOUR, trigger: 'revive' });
  add(store, '4', { author: 'dave', timestamp: 10 * HOUR + 60000 });
  const rows = store.randomStartersAll({ minGapMs: HOUR, limit: 10 });
  assert.deepEqual(rows.map((row) => row.author).sort(), ['alice', 'bob']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['author', 'content']);
  assert.equal(store.randomStartersAll({ minGapMs: HOUR, limit: 1 }).length, 1);
});

test('the topic queries are what the message store exposes', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(Object.keys(createMessageTopicQueries({ db })).sort(), ['randomCorpus', 'randomStartersAll', 'topicSample']);
});
