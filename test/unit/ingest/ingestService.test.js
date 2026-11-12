import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestService } from '../../../src/ingest/ingestService.js';

const record = { id: '1', author: 'alice', content: 'raw <@1>', timestamp: 5, reference: 'r1' };

const setup = ({ kept = true, vectorError = null } = {}) => {
  const calls = [];
  const filtered = { ...record, content: 'clean' };
  const messageStore = {
    insertRaw: (r) => calls.push(['insertRaw', r]),
    insertFiltered: (r) => {
      calls.push(['insertFiltered', r]);
      return { ...r, reference: 'resolved', hasGif: true };
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
  assert.deepEqual(result, { filtered });
});

test('KNOWN BUG (spec 10): passes the filter output, not the StoredMessage, to the vector store', async () => {
  const { ingest, calls, filtered } = setup();
  await ingest.recordMessage(record);
  const [sent] = calls[3][1];
  assert.equal(sent, filtered);
  assert.equal(sent.reference, 'r1');
  assert.equal('hasGif' in sent, false);
});

test('a dropped message is stored raw only', async () => {
  const { ingest, calls } = setup({ kept: false });
  const result = await ingest.recordMessage(record);
  assert.deepEqual(calls.map((c) => c[0]), ['insertRaw', 'filter']);
  assert.deepEqual(result, { filtered: null });
});

test('a vector store failure rejects after the rows were written', async () => {
  const { ingest, calls } = setup({ vectorError: new Error('chroma down') });
  await assert.rejects(ingest.recordMessage(record), /chroma down/);
  assert.deepEqual(calls.map((c) => c[0]), ['insertRaw', 'filter', 'insertFiltered', 'upsert']);
});
