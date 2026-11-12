import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createIngestService } from '../../../src/ingest/ingestService.js';

const config = { storage: { inferredReferenceWindowMs: 3600000 } };
const rec = (id, content, timestamp = 10) => ({ id, author: 'alice', content, timestamp, reference: null });
const vectorFailure = () => Object.assign(new Error('chroma down'), { isVectorError: true });

const setup = ({ error = null } = {}) => {
  const db = openDatabase(':memory:');
  const messageStore = createMessageStore({ db, config });
  const failures = [];
  const vectorStore = {
    upsertMessages: async () => {
      if (error) throw error;
    },
  };
  const ingest = createIngestService({
    messageStore, vectorStore, messageFilter: { filter: (r) => r }, botMessageStore: {},
    onVectorError: (e) => failures.push(e),
  });
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { ingest, failures, count };
};

test('recordMessage tolerates a vector error when asked: reports it, keeps the rows and flags the result', async () => {
  const error = vectorFailure();
  const { ingest, failures, count } = setup({ error });
  const result = await ingest.recordMessage(rec('1', 'hello there'), { tolerateVectorErrors: true });
  assert.equal(result.vectorFailed, true);
  assert.equal(result.stored.id, '1');
  assert.deepEqual(failures, [error]);
  assert.equal(count('messages'), 1);
  assert.equal(count('filtered_messages'), 1);
});

test('recordMessage rethrows a vector error unless tolerance is on', async () => {
  const error = vectorFailure();
  const { ingest, failures, count } = setup({ error });
  await assert.rejects(ingest.recordMessage(rec('1', 'hello there')), (e) => e === error);
  assert.deepEqual(failures, []);
  assert.equal(count('filtered_messages'), 1);
});

test('an error that is not a vector error is never tolerated', async () => {
  const error = new Error('sqlite broke');
  const { ingest, failures } = setup({ error });
  await assert.rejects(ingest.recordMessage(rec('1', 'hello there'), { tolerateVectorErrors: true }), (e) => e === error);
  assert.deepEqual(failures, []);
});

test('recordMessages never tolerates a vector error', async () => {
  const error = vectorFailure();
  const { ingest, failures } = setup({ error });
  await assert.rejects(ingest.recordMessages([{ record: rec('1', 'hello there') }]), (e) => e === error);
  assert.deepEqual(failures, []);
});

test('recordMessage without a vector failure reports vectorFailed false and no callback', async () => {
  const { ingest, failures } = setup();
  const result = await ingest.recordMessage(rec('1', 'hello there'), { tolerateVectorErrors: true });
  assert.equal(result.vectorFailed, false);
  assert.deepEqual(failures, []);
});

test('recordEdit tolerates a vector error for an edit of a known message', async () => {
  const error = vectorFailure();
  const { ingest, failures, count } = setup({ error });
  await ingest.recordMessage(rec('1', 'hello there'), { tolerateVectorErrors: true });
  const edit = { ...rec('1', 'new content here'), editedAt: 20 };
  const result = await ingest.recordEdit(edit, { tolerateVectorErrors: true });
  assert.deepEqual(result, { changed: true, vectorFailed: true });
  assert.equal(failures.length, 2);
  assert.equal(count('message_revisions'), 1);
});

test('recordEdit rethrows a vector error unless tolerance is on', async () => {
  const { ingest } = setup({ error: vectorFailure() });
  await ingest.recordMessage(rec('1', 'hello there'), { tolerateVectorErrors: true });
  const edit = { ...rec('1', 'new content here'), editedAt: 20 };
  await assert.rejects(ingest.recordEdit(edit), (e) => e.isVectorError === true);
});

test('recordEdit of an unknown message forwards the option to recordMessage', async () => {
  const { ingest, failures } = setup({ error: vectorFailure() });
  const edit = { ...rec('9', 'brand new content'), editedAt: 20 };
  assert.deepEqual(await ingest.recordEdit(edit, { tolerateVectorErrors: true }), { changed: true, vectorFailed: true });
  assert.equal(failures.length, 1);
});
