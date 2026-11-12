import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { buildBot, buildOrchestration, buildLifecycle } from '../../../src/container/bot.js';
import { buildAll } from '../../support/containerParts.js';

test('buildOrchestration returns the responder, chain builder, activity tracker and reply policy', () => {
  const { orchestration, storage } = buildAll();
  assert.deepEqual(Object.keys(orchestration).sort(), ['activity', 'chainBuilder', 'replyPolicy', 'responder']);
  assert.deepEqual(Object.keys(orchestration.responder), ['respond']);
  assert.deepEqual(Object.keys(orchestration.chainBuilder), ['build']);
  storage.db.close();
});

test('buildLifecycle closes the database by default and calls the given exit', async () => {
  const all = buildAll();
  const exits = [];
  const lifecycle = buildLifecycle({ ...all, exit: (code) => exits.push(code), closeDatabase: null });
  await lifecycle.shutdown({ reason: 'test', code: 3, graceMs: 0 });
  assert.deepEqual(exits, [3]);
  assert.throws(() => all.storage.db.prepare('SELECT 1').get(), /not open|closed/i);
});

test('buildLifecycle prefers a given closeDatabase', async () => {
  const all = buildAll();
  const closed = [];
  const lifecycle = buildLifecycle({ ...all, exit: () => {}, closeDatabase: () => closed.push(true) });
  await lifecycle.shutdown({ graceMs: 0 });
  assert.deepEqual(closed, [true]);
  all.storage.db.close();
});

test('buildBot registers the message and interaction handlers on the client', async () => {
  const all = buildAll();
  const bot = buildBot({
    config: all.config, data: all.data, clock: all.clock, logger: all.logger,
    parts: { ...all, catchUp: all.backfill.catchUp },
  });
  await all.storage.vectorStore.connect();
  await bot.start();
  const client = all.fakes.discord.state.client;
  [Events.MessageCreate, Events.MessageUpdate, Events.MessageDelete, Events.InteractionCreate].forEach((event) => {
    assert.equal(client.listenerCount(event), 1, String(event));
  });
  all.storage.db.close();
});
