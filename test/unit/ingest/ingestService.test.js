import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestService } from '../../../src/ingest/ingestService.js';

const record = { id: '1', author: 'alice', content: 'raw <@1>', timestamp: 5, reference: 'r1' };

const setup = ({ kept = true, vectorError = null, duplicate = false } = {}) => {
  const calls = [];
  const filtered = { ...record, content: 'clean' };
  const messageStore = {
    transaction: (fn) => fn(),
    insertRaw: (r) => (calls.push(['insertRaw', r]), true),
    insertFiltered: (r, options) => {
      calls.push(['insertFiltered', r, options]);
      return duplicate ? null : { ...r, reference: 'resolved', hasGif: true };
    },
  };
  const messageFilter = {
    filter: (r) => {
      calls.push(['filter', r]);
      return kept ? filtered : null;
    },
  };
  const vectorStore = {
    upsertMessages: async (msgs) => {
      calls.push(['upsert', msgs]);
      if (vectorError) throw vectorError;
    },
  };
  const ingest = createIngestService({ messageStore, vectorStore, messageFilter });
  return { ingest, calls, filtered };
};

test('records raw, filters, stores filtered, then upserts vectors in order', async () => {
  const { ingest, calls, filtered } = setup();
  const result = await ingest.recordMessage(record);
  assert.deepEqual(calls.map((c) => c[0]), ['insertRaw', 'filter', 'insertFiltered', 'upsert']);
  assert.equal(calls[0][1], record);
  assert.equal(calls[1][1], record);
  assert.equal(calls[2][1], filtered);
  assert.equal(result.filtered, filtered);
  assert.equal(result.stored.reference, 'resolved');
});

test('passes the StoredMessage with resolved reference and hasGif to the vector store', async () => {
  const { ingest, calls } = setup();
  const { stored } = await ingest.recordMessage(record);
  const [sent] = calls[3][1];
  assert.equal(sent, stored);
  assert.equal(sent.reference, 'resolved');
  assert.equal(sent.hasGif, true);
});

test('a duplicate makes no vector call and returns stored null', async () => {
  const { ingest, calls, filtered } = setup({ duplicate: true });
  const result = await ingest.recordMessage(record);
  assert.deepEqual(calls.map((c) => c[0]), ['insertRaw', 'filter', 'insertFiltered']);
  assert.deepEqual(result, { filtered, stored: null, vectorFailed: false });
});

test('a dropped message is stored raw only', async () => {
  const { ingest, calls } = setup({ kept: false });
  const result = await ingest.recordMessage(record);
  assert.deepEqual(calls.map((c) => c[0]), ['insertRaw', 'filter']);
  assert.deepEqual(result, { filtered: null, stored: null, vectorFailed: false });
});

test('a vector store failure rejects after the rows were written', async () => {
  const { ingest, calls } = setup({ vectorError: new Error('chroma down') });
  await assert.rejects(ingest.recordMessage(record), /chroma down/);
  assert.deepEqual(calls.map((c) => c[0]), ['insertRaw', 'filter', 'insertFiltered', 'upsert']);
});

test('repliesToBot stops the store from inferring a reference', async () => {
  const { ingest, calls } = setup();
  await ingest.recordMessage(record, { repliesToBot: true });
  const insert = calls.find(([name]) => name === 'insertFiltered');
  assert.deepEqual(insert[2], { inferReference: false });
});

test('references are inferred by default', async () => {
  const { ingest, calls } = setup();
  await ingest.recordMessage(record);
  assert.deepEqual(calls.find(([name]) => name === 'insertFiltered')[2], { inferReference: true });
});

const setupEdit = ({ raw = { content: 'old', deleted: false }, kept = true, stored = { id: '1:9' }, vectorError = null } = {}) => {
  const calls = [];
  const filtered = { id: '1', content: 'new' };
  const messageStore = {
    transaction: (fn) => fn(),
    insertRaw: (r) => (calls.push(['insertRaw', r]), true),
    insertFiltered: () => ({ id: '1' }),
    getRaw: (id) => (calls.push(['getRaw', id]), raw),
    applyEdit: (args) => (calls.push(['applyEdit', args]), stored),
    softDelete: (id, at) => calls.push(['softDelete', id, at]),
  };
  const botMessageStore = { softDelete: (id, at) => calls.push(['botSoftDelete', id, at]) };
  const messageFilter = { filter: (r) => (calls.push(['filter', r]), kept ? filtered : null) };
  const vectorStore = {
    upsertMessages: async (msgs) => {
      calls.push(['upsert', msgs]);
      if (vectorError) throw vectorError;
    },
  };
  const ingest = createIngestService({ messageStore, vectorStore, messageFilter, botMessageStore });
  return { ingest, calls, filtered };
};
const edited = { id: '1', author: 'alice', content: 'new', timestamp: 5, reference: null, editedAt: 9 };

test('recordEdit applies the edit and upserts the new corpus row', async () => {
  const { ingest, calls, filtered } = setupEdit();
  assert.deepEqual(await ingest.recordEdit(edited), { changed: true, vectorFailed: false });
  assert.deepEqual(calls.map((c) => c[0]), ['getRaw', 'filter', 'applyEdit', 'upsert']);
  assert.deepEqual(calls[2][1], { id: '1', content: 'new', editedAt: 9, filtered, inferReference: true });
  assert.deepEqual(calls[3][1], [{ id: '1:9' }]);
});

test('recordEdit passes inferReference false for replies to the bot', async () => {
  const { ingest, calls } = setupEdit();
  await ingest.recordEdit(edited, { repliesToBot: true });
  assert.equal(calls.find((c) => c[0] === 'applyEdit')[1].inferReference, false);
});

test('recordEdit of an unknown message records it as new', async () => {
  const { ingest, calls } = setupEdit({ raw: null });
  assert.deepEqual(await ingest.recordEdit(edited), { changed: true, vectorFailed: false });
  assert.deepEqual(calls.map((c) => c[0]), ['getRaw', 'insertRaw', 'filter', 'upsert']);
  assert.equal(calls[1][1].editedAt, undefined);
});

test('recordEdit ignores a deleted message and unchanged content', async () => {
  const deleted = setupEdit({ raw: { content: 'old', deleted: true } });
  assert.deepEqual(await deleted.ingest.recordEdit(edited), { changed: false, vectorFailed: false });
  const same = setupEdit({ raw: { content: 'new', deleted: false } });
  assert.deepEqual(await same.ingest.recordEdit(edited), { changed: false, vectorFailed: false });
  assert.deepEqual([...deleted.calls, ...same.calls].map((c) => c[0]).filter((n) => n !== 'getRaw'), []);
});

test('recordEdit stores a revision without a vector when the filter drops the edit or the edit is a no-op', async () => {
  const dropped = setupEdit({ kept: false, stored: null });
  assert.deepEqual(await dropped.ingest.recordEdit(edited), { changed: true, vectorFailed: false });
  assert.equal(dropped.calls.some((c) => c[0] === 'upsert'), false);
  assert.equal(dropped.calls.find((c) => c[0] === 'applyEdit')[1].filtered, null);
});

test('recordEdit rejects when the vector store fails, after SQLite was updated', async () => {
  const { ingest, calls } = setupEdit({ vectorError: new Error('chroma down') });
  await assert.rejects(ingest.recordEdit(edited), /chroma down/);
  assert.ok(calls.some((c) => c[0] === 'applyEdit'));
});

test('recordDelete soft-deletes in both stores', () => {
  const { ingest, calls } = setupEdit();
  ingest.recordDelete('7', 42);
  assert.deepEqual(calls, [['softDelete', '7', 42], ['botSoftDelete', '7', 42]]);
});
