import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageUpdateHandler } from '../../../../src/bot/handlers/messageUpdate.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';

const config = loadConfig({});
const CHANNEL = config.discord.channelId;

const setup = ({ bots = {}, fail = false } = {}) => {
  const edits = [];
  const errors = [];
  const ingest = {
    recordEdit: async (record, options) => {
      if (fail) throw new Error('db down');
      edits.push([record, options]);
    },
  };
  const handler = createMessageUpdateHandler({
    config, ingest, botMessageStore: { getById: (id) => bots[id] ?? null },
    clock: { now: () => 777 }, logger: { error: (...args) => errors.push(args) },
  });
  const discord = createFakeDiscord();
  const make = (fields) => discord.makeMessage({ channel: discord.state.channel, ...fields });
  return { handler, edits, errors, make };
};

test('records the edit with the edit time and the message record', async () => {
  const { handler, edits, make } = setup();
  const message = make({ id: 'm1', author: 'alice', content: 'new', timestamp: 5 });
  message.editedTimestamp = 99;
  await handler.onUpdate({}, message);
  assert.deepEqual(edits, [[
    { id: 'm1', author: 'alice', content: 'new', timestamp: 5, reference: null, editedAt: 99 },
    { repliesToBot: false },
  ]]);
});

test('falls back to the clock when there is no edit timestamp', async () => {
  const { handler, edits, make } = setup();
  await handler.onUpdate({}, make({ id: 'm1', content: 'new' }));
  assert.equal(edits[0][0].editedAt, 777);
});

test('flags edits of replies to bot messages', async () => {
  const { handler, edits, make } = setup({ bots: { b1: { id: 'b1' } } });
  await handler.onUpdate({}, make({ id: 'm1', reference: 'b1' }));
  assert.equal(edits[0][1].repliesToBot, true);
  assert.equal(edits[0][0].reference, 'b1');
});

test('fetches a partial message before reading it', async () => {
  const { handler, edits, make } = setup();
  const full = make({ id: 'm1', content: 'full text', author: 'bob' });
  full.editedTimestamp = 5;
  const partial = { id: 'm1', channelId: CHANNEL, partial: true, fetch: async () => full };
  await handler.onUpdate({}, partial);
  assert.equal(edits[0][0].content, 'full text');
  assert.equal(edits[0][0].author, 'bob');
});

test('ignores other channels and bot authors', async () => {
  const { handler, edits, make } = setup();
  const discord = createFakeDiscord();
  await handler.onUpdate({}, discord.makeMessage({ channel: discord.state.otherChannel }));
  await handler.onUpdate({}, make({ bot: true }));
  assert.deepEqual(edits, []);
});

test('logs errors and never throws', async () => {
  const { handler, errors, make } = setup({ fail: true });
  await handler.onUpdate({}, make({ content: 'x' }));
  await handler.onUpdate({}, { channelId: CHANNEL, partial: true, fetch: async () => { throw new Error('gone'); } });
  assert.equal(errors.length, 2);
});
