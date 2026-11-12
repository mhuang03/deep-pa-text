import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createBotMessageStore } from '../../../src/storage/botMessageStore.js';
import { RANDOM_STARTERS } from '../../../src/storage/messageSql.js';

const HOUR = 3600000;
const SCALE_MESSAGES = 20000;
const SCALE_BOUND_MS = 1000;
const config = { storage: { inferredReferenceWindowMs: HOUR, chunkSize: 500 }, burst: { siblingWindowMs: 1000 } };

const setup = () => {
  const db = openDatabase(':memory:');
  return {
    db,
    store: createMessageStore({ db, config }),
    botStore: createBotMessageStore({ db, config }),
  };
};
const add = (store, id, author, timestamp) => {
  const record = { id, author, content: `content ${id}`, timestamp, reference: null };
  store.insertRaw(record);
  store.insertFiltered(record, { inferReference: false });
};
const starters = (store, author) => store.randomStarters({ author, minGapMs: HOUR, limit: 50 }).sort();

test('a human message shortly after a bot revive is not a starter', () => {
  const { store, botStore } = setup();
  add(store, '1', 'a', 0);
  botStore.insert({ id: 'b1', persona: 'a', content: 'revive', timestamp: 3 * HOUR, trigger: 'revive' });
  add(store, '2', 'b', 3 * HOUR + 5 * 60000);
  assert.deepEqual(starters(store, 'b'), []);
});

test('a human message more than an hour after any message, bot or human, is a starter', () => {
  const { store, botStore } = setup();
  add(store, '1', 'a', 0);
  botStore.insert({ id: 'b1', persona: 'a', content: 'revive', timestamp: 3 * HOUR, trigger: 'revive' });
  add(store, '2', 'b', 5 * HOUR);
  assert.deepEqual(starters(store, 'b'), ['content 2']);
});

test('a deleted bot message is not a neighbour', () => {
  const { store, botStore } = setup();
  add(store, '1', 'a', 0);
  botStore.insert({ id: 'b1', persona: 'a', content: 'revive', timestamp: 3 * HOUR, trigger: 'revive' });
  add(store, '2', 'b', 3 * HOUR + 60000);
  botStore.softDelete('b1', 4 * HOUR);
  assert.deepEqual(starters(store, 'b'), ['content 2']);
});

test('the starter statement joins the gap sequence by an index, not a per-row rescan', () => {
  const { db } = setup();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${RANDOM_STARTERS}`).all('a', HOUR, 5)
    .map((row) => row.detail).join('\n');
  assert.match(plan, /AUTOMATIC|SEARCH g/);
});

test('randomStarters on 20,000 raw messages returns within the bound', () => {
  const { db, store } = setup();
  db.exec('BEGIN');
  for (let i = 0; i < SCALE_MESSAGES; i += 1) add(store, `m${i}`, i % 2 === 0 ? 'a' : 'b', i * 1000 * (i % 7 === 0 ? 300 : 1));
  db.exec('COMMIT');
  const start = process.hrtime.bigint();
  store.randomStarters({ author: 'a', minGapMs: HOUR, limit: 5 });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < SCALE_BOUND_MS, `took ${elapsedMs} ms`);
});
