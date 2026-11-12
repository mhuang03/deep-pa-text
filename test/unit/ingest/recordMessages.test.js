import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createIngestService } from '../../../src/ingest/ingestService.js';

const HOUR = 3600000;
const config = { storage: { inferredReferenceWindowMs: HOUR } };
const rec = (id, author, timestamp, extra = {}) => ({
  id, author, content: `content ${id}`, timestamp, reference: null, ...extra,
});

const setup = ({ dropIds = [], vectorError = null, filterError = null } = {}) => {
  const db = openDatabase(':memory:');
  const messageStore = createMessageStore({ db, config });
  const upserts = [];
  const vectorStore = {
    upsertMessages: async (msgs) => {
      upserts.push(msgs);
      if (vectorError) throw vectorError;
    },
  };
  const messageFilter = {
    filter: (record) => {
      if (filterError && record.id === filterError.id) throw filterError.error;
      return dropIds.includes(record.id) ? null : record;
    },
  };
  const ingest = createIngestService({ messageStore, vectorStore, messageFilter, botMessageStore: {} });
  return { db, ingest, upserts };
};
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const referenceOf = (db, id) => db.prepare('SELECT reference FROM filtered_messages WHERE id = ?').get(id).reference;

test('recordMessages stores the batch in order so later entries resolve references to earlier ones', async () => {
  const { db, ingest } = setup();
  const { results, insertedRaw, kept } = await ingest.recordMessages([
    { record: rec('1', 'a', 10) },
    { record: rec('2', 'b', 20) },
    { record: rec('3', 'a', 30, { reference: '1' }) },
  ]);
  assert.equal(insertedRaw, 3);
  assert.equal(kept, 3);
  assert.deepEqual(results.map((r) => r.stored.id), ['1', '2', '3']);
  assert.equal(referenceOf(db, '2'), '1');
  assert.equal(referenceOf(db, '3'), '1');
});

test('recordMessages makes one vector upsert for the whole batch', async () => {
  const { ingest, upserts } = setup();
  await ingest.recordMessages([{ record: rec('1', 'a', 10) }, { record: rec('2', 'b', 20) }]);
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].map((m) => m.id), ['1', '2']);
});

test('recordMessages makes no vector call when the filter drops every message', async () => {
  const { db, ingest, upserts } = setup({ dropIds: ['1', '2'] });
  const result = await ingest.recordMessages([{ record: rec('1', 'a', 10) }, { record: rec('2', 'b', 20) }]);
  assert.equal(upserts.length, 0);
  assert.equal(result.insertedRaw, 2);
  assert.equal(result.kept, 0);
  assert.deepEqual(result.results, [{ filtered: null, stored: null }, { filtered: null, stored: null }]);
  assert.equal(count(db, 'messages'), 2);
  assert.equal(count(db, 'filtered_messages'), 0);
});

test('recordMessages with no entries does nothing', async () => {
  const { ingest, upserts } = setup();
  assert.deepEqual(await ingest.recordMessages([]), { results: [], insertedRaw: 0, kept: 0 });
  assert.equal(upserts.length, 0);
});

test('recordMessages counts only new raw rows and stored corpus rows', async () => {
  const { ingest, upserts } = setup();
  await ingest.recordMessages([{ record: rec('1', 'a', 10) }]);
  const again = await ingest.recordMessages([{ record: rec('1', 'a', 10) }, { record: rec('2', 'b', 20) }]);
  assert.equal(again.insertedRaw, 1);
  assert.equal(again.kept, 1);
  assert.deepEqual(upserts[1].map((m) => m.id), ['2']);
});

test('recordMessages applies repliesToBot per entry', async () => {
  const { db, ingest } = setup();
  await ingest.recordMessages([
    { record: rec('1', 'a', 10) },
    { record: rec('2', 'b', 20), repliesToBot: true },
    { record: rec('3', 'c', 30) },
  ]);
  assert.equal(referenceOf(db, '2'), null);
  assert.equal(referenceOf(db, '3'), '2');
});

test('the SQLite writes of a batch are atomic', async () => {
  const boom = new Error('filter broke');
  const { db, ingest, upserts } = setup({ filterError: { id: '2', error: boom } });
  await assert.rejects(ingest.recordMessages([{ record: rec('1', 'a', 10) }, { record: rec('2', 'b', 20) }]), boom);
  assert.equal(count(db, 'messages'), 0);
  assert.equal(count(db, 'filtered_messages'), 0);
  assert.equal(upserts.length, 0);
});

test('a vector failure rejects after the batch was written and keeps the error as given', async () => {
  const boom = Object.assign(new Error('chroma down'), { isVectorError: true });
  const { db, ingest } = setup({ vectorError: boom });
  await assert.rejects(ingest.recordMessages([{ record: rec('1', 'a', 10) }]), (error) => {
    assert.equal(error, boom);
    return true;
  });
  assert.equal(count(db, 'filtered_messages'), 1);
});

test('recordMessage returns the same result as the first entry of recordMessages', async () => {
  const single = setup();
  const batch = setup();
  const options = { repliesToBot: true };
  const a = await single.ingest.recordMessage(rec('1', 'a', 10), options);
  const b = await batch.ingest.recordMessages([{ record: rec('1', 'a', 10), ...options }]);
  assert.deepEqual(a, { ...b.results[0], vectorFailed: false });
  assert.equal(single.upserts.length, 1);
});
