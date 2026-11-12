import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatchUp } from '../../../src/backfill/catchUp.js';
import { loadConfig } from '../../../src/config.js';

const msg = (id) => ({
  id, content: `message ${id}`, createdTimestamp: Number(id), editedTimestamp: null,
  author: { id: 'u', username: 'alice', bot: false }, embeds: [], url: `u${id}`,
});

const setup = ({ newest = { id: '10', timestamp: 10 }, channelIds = [], env = {}, maxMessages, shuttingDown = () => false, fail = null } = {}) => {
  const config = loadConfig(env);
  const catchUpConfig = { ...config.catchUp, ...(maxMessages ? { maxMessages } : {}) };
  const fetches = [];
  const imports = [];
  const warnings = [];
  const catchUp = createCatchUp({
    channelHistory: {
      fetchAfter: async (channel, options) => {
        fetches.push(options);
        if (fail) throw fail;
        const later = channelIds.filter((id) => Number(id) > Number(options.after));
        return later.slice(0, options.limit).map(msg);
      },
    },
    historyImporter: {
      importMessages: async (messages, { channel }) => {
        imports.push({ ids: messages.map((m) => m.id), channel });
        return { insertedRaw: messages.length, kept: messages.length - 1 };
      },
    },
    messageStore: { newestRaw: (options) => { fetches.push({ newestRaw: options }); return newest; } },
    lifecycle: { isShuttingDown: shuttingDown },
    clock: { setTimeout, clearTimeout },
    config: { ...config, catchUp: catchUpConfig },
    logger: { warn: (m) => warnings.push(m) },
  });
  return { catchUp, fetches, imports, warnings };
};

test('an empty database returns zeros and fetches nothing', async () => {
  const { catchUp, fetches } = setup({ newest: null });
  assert.deepEqual(await catchUp.run('chan'), { fetched: 0, insertedRaw: 0, kept: 0, capped: false });
  assert.equal(fetches.some((f) => f.after), false);
});

test('the cursor starts from the newest raw row including deleted ones', async () => {
  const { catchUp, fetches } = setup();
  await catchUp.run('chan');
  assert.deepEqual(fetches[0], { newestRaw: { includeDeleted: true } });
});

test('pages forward until a page is empty and imports every page for the channel', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => String(11 + i));
  const { catchUp, fetches, imports } = setup({ channelIds: ids });
  const result = await catchUp.run('chan');
  assert.deepEqual(result, { fetched: 150, insertedRaw: 150, kept: 148, capped: false });
  assert.deepEqual(fetches.filter((f) => f.after).map((f) => [f.after, f.limit]), [['10', 100], ['110', 100], ['160', 100]]);
  assert.deepEqual(imports.map((i) => i.ids.length), [100, 50]);
  assert.equal(imports[0].channel, 'chan');
});

test('stops at the cap, reports capped and warns to run the backfill', async () => {
  const ids = Array.from({ length: 300 }, (_, i) => String(11 + i));
  const { catchUp, fetches, warnings } = setup({ channelIds: ids, maxMessages: 150 });
  const result = await catchUp.run('chan');
  assert.equal(result.fetched, 150);
  assert.equal(result.capped, true);
  assert.deepEqual(fetches.filter((f) => f.after).map((f) => f.limit), [100, 50]);
  assert.match(warnings[0], /npm run backfill/);
});

test('is not capped when the channel had exactly the cap and the next page is empty', async () => {
  const ids = Array.from({ length: 50 }, (_, i) => String(11 + i));
  const { catchUp } = setup({ channelIds: ids, maxMessages: 100 });
  assert.equal((await catchUp.run('chan')).capped, false);
});

test('does nothing when disabled', async () => {
  const { catchUp, fetches } = setup({ env: { CATCH_UP: 'false' }, channelIds: ['11'] });
  assert.equal((await catchUp.run('chan')).fetched, 0);
  assert.deepEqual(fetches, []);
});

test('stops before fetching when shutdown has begun', async () => {
  const { catchUp, fetches } = setup({ channelIds: ['11'], shuttingDown: () => true });
  assert.equal((await catchUp.run('chan')).fetched, 0);
  assert.equal(fetches.some((f) => f.after), false);
});

test('a failing fetch propagates for the caller to log', async () => {
  const { catchUp } = setup({ fail: new Error('503'), channelIds: ['11'] });
  await assert.rejects(catchUp.run('chan'), /503/);
});
