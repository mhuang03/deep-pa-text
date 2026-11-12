import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStartup } from '../../../src/bot/startup.js';
import { isConfigError } from '../../../src/config.js';

const setup = ({ meta = {}, connect = async () => {} } = {}) => {
  const calls = [];
  const startup = createStartup({
    metaStore: { get: (key) => meta[key] ?? null },
    vectorStore: { connect: async () => { calls.push('connect'); await connect(); } },
    bot: { start: async () => calls.push('start') },
    config: { chroma: { port: 7429 } },
  });
  return { startup, calls };
};

test('connects the vector store, then starts the bot', async () => {
  const { startup, calls } = setup();
  await startup.run();
  assert.deepEqual(calls, ['connect', 'start']);
});

test('refuses an unfinished re-import before connecting anything', async () => {
  const { startup, calls } = setup({ meta: { reimport_started_at: '5' } });
  await assert.rejects(startup.run(), (e) => isConfigError(e) && /npm run reimport -- --resume --yes/.test(e.message));
  assert.deepEqual(calls, []);
});

test('a finished re-import starts normally', async () => {
  const { startup, calls } = setup({ meta: { reimport_started_at: '5', reimport_completed_at: '9' } });
  await startup.run();
  assert.deepEqual(calls, ['connect', 'start']);
});

test('an unreachable Chroma becomes a one-line config error naming the port; the bot never starts', async () => {
  const { startup, calls } = setup({ connect: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(startup.run(), (e) => isConfigError(e)
    && !e.message.includes('\n') && e.message.includes('7429') && e.message.includes('npx chroma run --port 7429'));
  assert.deepEqual(calls, ['connect']);
});
