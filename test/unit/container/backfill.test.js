import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfill } from '../../../src/container/backfill.js';
import { buildAll } from '../../support/containerParts.js';

test('returns the history reader, importers and catch-up', () => {
  const { backfill, storage } = buildAll();
  assert.deepEqual(Object.keys(backfill).sort(), ['botMessageImporter', 'catchUp', 'historyImporter', 'historyReader']);
  assert.deepEqual(Object.keys(backfill.historyReader), ['readAll']);
  assert.deepEqual(Object.keys(backfill.historyImporter).sort(), ['importMessages', 'run']);
  assert.deepEqual(Object.keys(backfill.catchUp), ['run']);
  storage.db.close();
});

test('the catch-up stops paging once the lifecycle is shutting down', async () => {
  const all = buildAll();
  const lifecycle = { isShuttingDown: () => true };
  const { catchUp } = buildBackfill({ ...all, lifecycle });
  all.storage.messageStore.insertRaw({ id: '5', author: 'alice', content: 'x', timestamp: 1, reference: null });
  const totals = await catchUp.run({ id: 'c', messages: { fetch: async () => { throw new Error('must not fetch'); } } });
  assert.deepEqual(totals, { fetched: 0, insertedRaw: 0, kept: 0, capped: false });
  all.storage.db.close();
});

test('the history importer imports through the wired ingest service', async () => {
  const all = buildAll();
  const reader = all.backfill.historyImporter;
  const totals = await reader.importMessages([], { channel: { id: 'c', fetchWebhooks: async () => new Map() }, dryRun: true });
  assert.equal(totals.insertedRaw, 0);
  assert.equal(totals.alreadyStored, 0);
  all.storage.db.close();
});
