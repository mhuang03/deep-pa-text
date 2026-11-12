import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageDeleteHandler } from '../../../../src/bot/handlers/messageDelete.js';
import { loadConfig } from '../../../../src/config.js';

const config = loadConfig({});
const CHANNEL = config.discord.channelId;

const setup = ({ fail = false } = {}) => {
  const deletes = [];
  const errors = [];
  const ingest = {
    recordDelete: (id, at) => {
      if (fail) throw new Error('db down');
      deletes.push([id, at]);
    },
  };
  const handler = createMessageDeleteHandler({
    config, ingest, clock: { now: () => 1234 }, logger: { error: (...args) => errors.push(args) },
  });
  return { handler, deletes, errors };
};

test('onDelete records the delete with the clock time', async () => {
  const { handler, deletes } = setup();
  await handler.onDelete({ id: 'm1', channelId: CHANNEL, partial: true });
  assert.deepEqual(deletes, [['m1', 1234]]);
});

test('onDelete ignores other channels', async () => {
  const { handler, deletes } = setup();
  await handler.onDelete({ id: 'm1', channelId: 'other' });
  assert.deepEqual(deletes, []);
});

test('onBulkDelete records every message of the collection in the channel', async () => {
  const { handler, deletes } = setup();
  await handler.onBulkDelete(new Map([
    ['a', { id: 'a', channelId: CHANNEL }], ['b', { id: 'b', channelId: CHANNEL }],
    ['c', { id: 'c', channelId: 'other' }],
  ]));
  assert.deepEqual(deletes, [['a', 1234], ['b', 1234]]);
});

test('errors are logged and never thrown', async () => {
  const { handler, errors } = setup({ fail: true });
  await handler.onDelete({ id: 'm1', channelId: CHANNEL });
  await handler.onBulkDelete(new Map([['a', { id: 'a', channelId: CHANNEL }]]));
  assert.equal(errors.length, 2);
});
