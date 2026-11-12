import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncPage } from '../../../src/ingest/vectorSyncSteps.js';

const row = (id, extra = {}) => ({ id, author: 'a', content: `c${id}`, timestamp: 1, reference: null, hasGif: false, ...extra });
const intact = (id, metadata = { author: 'a' }) => ({ document: `c${id}`, embedding: [1, 2], metadata });

const setup = ({ messages = {}, replies = {} } = {}) => {
  const calls = { upsertMessages: [], fillMetadata: [], addReplyRows: [] };
  const stores = { messages: new Map(Object.entries(messages)), replies: new Map(Object.entries(replies)) };
  const vectorStore = {
    getRecords: async (name, ids) => new Map(ids.filter((id) => stores[name].has(id)).map((id) => [id, stores[name].get(id)])),
    upsertMessages: async (rows) => calls.upsertMessages.push(rows.map((r) => r.id)),
    fillMetadata: async (name, rows) => calls.fillMetadata.push([name, rows]),
    addReplyRows: async (rows) => calls.addReplyRows.push(rows),
  };
  return { ctx: { vectorStore }, calls };
};

test('adds the messages Chroma lacks and counts the rows checked', async () => {
  const { ctx, calls } = setup({ messages: { 1: intact('1', { author: 'a', has_gif: false }) } });
  const result = await syncPage(ctx, [row('1'), row('2')], false);
  assert.deepEqual(calls.upsertMessages, [['2']]);
  assert.equal(result.checked, 2);
  assert.equal(result.addedMessages, 1);
});

test('fills a missing has_gif key from SQLite and passes the document and embedding back unchanged', async () => {
  const { ctx, calls } = setup({ messages: { 1: intact('1') } });
  const result = await syncPage(ctx, [row('1', { hasGif: true })], false);
  assert.equal(result.filledMetadata, 1);
  assert.deepEqual(calls.fillMetadata[0], ['messages', [{ id: '1', document: 'c1', embedding: [1, 2], metadata: { author: 'a', has_gif: true } }]]);
});

test('a row without a usable document or embedding is skipped, never rewritten', async () => {
  const { ctx, calls } = setup({ messages: { 1: { document: '', embedding: [1], metadata: {} }, 2: { document: 'c2', embedding: [], metadata: {} } } });
  const result = await syncPage(ctx, [row('1'), row('2')], false);
  assert.equal(result.skipped, 2);
  assert.deepEqual(calls.fillMetadata[0][1], []);
});

test('adds a missing reply row with the parent embedding, and skips one whose parent has none', async () => {
  const { ctx, calls } = setup({ messages: { p: intact('p', { author: 'a', has_gif: false }), c: intact('c', { has_gif: false }), d: intact('d', { has_gif: false }) } });
  const rows = [row('c', { reference: 'p' }), row('d', { reference: 'ghost' })];
  const result = await syncPage(ctx, rows, false);
  assert.deepEqual(calls.addReplyRows[0].map((r) => [r.message.id, r.embedding]), [['c', [1, 2]]]);
  assert.equal(result.addedReplies, 1);
  assert.equal(result.skipped, 1);
});

test('a dry run counts what it would do and writes nothing', async () => {
  const { ctx, calls } = setup({ messages: { 1: intact('1') } });
  const result = await syncPage(ctx, [row('1'), row('2')], true);
  assert.deepEqual(calls, { upsertMessages: [], fillMetadata: [], addReplyRows: [] });
  assert.equal(result.addedMessages, 1);
  assert.equal(result.filledMetadata, 1);
});

test('a dry run leaves rows it would add out of the reply check', async () => {
  const { ctx } = setup();
  const result = await syncPage(ctx, [row('c', { reference: 'p' })], true);
  assert.equal(result.addedMessages, 1);
  assert.equal(result.addedReplies, 0);
});
