import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createBotMessageStore } from '../../../src/storage/botMessageStore.js';
import { createProfileStore } from '../../../src/storage/profileStore.js';
import { buildUserDirectory } from '../../../src/userData/loadData.js';
import { createIngestService } from '../../../src/ingest/ingestService.js';
import { createBotMessageImporter } from '../../../src/backfill/botMessageImporter.js';
import { createHistoryImporter } from '../../../src/backfill/historyImporter.js';

const USERS = [{ username: 'alice', name: 'Alice' }, { username: 'bob', name: 'Bob' }];
const config = {
  storage: { inferredReferenceWindowMs: 3600000 },
  burst: { siblingWindowMs: 1000 },
  discord: { webhookUsernameMax: 80 },
  backfill: { batchSize: 2 },
};

const human = (id, author, timestamp, extra = {}) => ({
  id, content: `message ${id}`, createdTimestamp: timestamp, editedTimestamp: null, webhookId: null,
  author: { id: `u-${author}`, username: author, bot: false }, reference: null, embeds: [], url: `u/${id}`, ...extra,
});
const botMessage = (id, persona, timestamp, extra = {}) => ({
  ...human(id, 'deep-pa-text', timestamp, extra),
  author: { id: 'bot', username: 'deep-pa-text', bot: true }, embeds: [{ author: { name: persona } }],
});

const setup = ({ ownedIds = async () => new Set(), readAll = async () => [], shortFilter = false } = {}) => {
  const db = openDatabase(':memory:');
  const messageStore = createMessageStore({ db, config });
  const botMessageStore = createBotMessageStore({ db, config });
  const profileStore = createProfileStore({ db });
  const upserts = [];
  const vectorStore = { upsertMessages: async (msgs) => upserts.push(msgs) };
  const messageFilter = { filter: (r) => (shortFilter && r.content.length < 3 ? null : r) };
  const ingest = createIngestService({ messageStore, vectorStore, messageFilter, botMessageStore });
  const logs = { info: [], warn: [] };
  const logger = { info: (...a) => logs.info.push(a), warn: (...a) => logs.warn.push(a) };
  const botMessageImporter = createBotMessageImporter({
    botMessageStore, profileStore, userDirectory: buildUserDirectory(USERS), config, logger,
  });
  const importer = createHistoryImporter({
    historyReader: { readAll }, botMessageImporter, ingest, messageStore, botMessageStore, messageFilter,
    webhooks: { ownedIds }, getBotUserId: () => 'bot', config, logger,
  });
  return { importer, db, botMessageStore, upserts, logs };
};
const channel = { id: 'c' };
const rows = (db, table) => db.prepare(`SELECT id, reference FROM ${table} ORDER BY timestamp, id`).all();

test('an empty history gives all zeros', async () => {
  const { importer } = setup();
  assert.deepEqual(await importer.importMessages([], { channel }), {
    otherBots: 0, botMessages: { imported: 0, alreadyStored: 0, unattributed: 0, skippedEmpty: 0 },
    alreadyStored: 0, insertedRaw: 0, kept: 0,
  });
});

test('imports human messages oldest first in batches and counts them', async () => {
  const { importer, db, upserts, logs } = setup();
  const messages = [1, 2, 3, 4, 5].map((n) => human(`m${n}`, n % 2 ? 'alice' : 'bob', n * 10));
  const result = await importer.importMessages(messages, { channel });
  assert.equal(result.insertedRaw, 5);
  assert.equal(result.kept, 5);
  assert.deepEqual(upserts.map((batch) => batch.length), [2, 2, 1]);
  assert.deepEqual(rows(db, 'filtered_messages').map((r) => r.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(logs.info.length, 3);
});

test('links an inferred-reference pair split across batches', async () => {
  const { importer, db } = setup();
  await importer.importMessages([human('a', 'alice', 10), human('b', 'bob', 20), human('c', 'alice', 30)], { channel });
  assert.deepEqual(rows(db, 'filtered_messages').map((r) => r.reference), [null, 'a', 'b']);
});

test('skips messages that already have a raw row and counts them', async () => {
  const { importer } = setup();
  const messages = [human('a', 'alice', 10), human('b', 'bob', 20)];
  const first = await importer.importMessages(messages, { channel });
  const second = await importer.importMessages(messages, { channel });
  assert.equal(second.alreadyStored, first.insertedRaw);
  assert.equal(second.insertedRaw, 0);
});

test('drops other bots and webhooks of other applications', async () => {
  const { importer, db } = setup({ ownedIds: async () => new Set(['wh-own']) });
  const other = human('x', 'Proxy', 5, { author: { id: 'wh-x', username: 'Alice', bot: true }, webhookId: 'wh-x' });
  const result = await importer.importMessages([other, human('a', 'alice', 10)], { channel });
  assert.equal(result.otherBots, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bot_messages').get().n, 0);
  assert.equal(result.insertedRaw, 1);
});

test('imports own bot messages and stores a human reply to one with no reference', async () => {
  const { importer, db, botMessageStore } = setup();
  const messages = [
    human('h1', 'alice', 10),
    botMessage('b1', 'bob', 20, { reference: { messageId: 'h1' } }),
    human('h2', 'alice', 30, { reference: { messageId: 'b1' } }),
  ];
  const result = await importer.importMessages(messages, { channel });
  assert.equal(result.botMessages.imported, 1);
  assert.equal(botMessageStore.getById('b1').persona, 'bob');
  assert.equal(rows(db, 'filtered_messages').find((r) => r.id === 'h2').reference, null);
});

test('a reply to a bot message stored earlier is also recognised', async () => {
  const { importer, db, botMessageStore } = setup();
  botMessageStore.insert({ id: 'old', persona: 'bob', content: 'x', timestamp: 1, trigger: 'auto' });
  await importer.importMessages(
    [human('h1', 'bob', 10), human('h2', 'alice', 20, { reference: { messageId: 'old' } })], { channel },
  );
  assert.equal(rows(db, 'filtered_messages').find((r) => r.id === 'h2').reference, null);
});

test('messages known from a previous database count as the bot\'s own and use their stored rows', async () => {
  const { importer, botMessageStore } = setup();
  const known = { persona: 'alice', content: 'kept <gif! cat>', reference: null, trigger: 'revive' };
  const hook = human('b9', 'Alice', 20, { author: { id: 'gone', username: 'Alice', bot: true }, webhookId: 'gone' });
  const result = await importer.importMessages([hook], {
    channel, botMessageLookup: (id) => (id === 'b9' ? known : null),
  });
  assert.equal(result.otherBots, 0);
  assert.equal(botMessageStore.getById('b9').trigger, 'revive');
});

test('a webhook listing failure is logged and leaves only known webhook messages recognised', async () => {
  const { importer, logs } = setup({ ownedIds: async () => { throw new Error('Missing Permissions'); } });
  const hook = human('w', 'Alice', 20, { author: { id: 'wh', username: 'Alice', bot: true }, webhookId: 'wh' });
  const result = await importer.importMessages([hook], { channel });
  assert.equal(result.otherBots, 1);
  assert.equal(logs.warn.length, 1);
});

test('a batch the filter drops entirely writes raw rows and makes no vector call', async () => {
  const { importer, db, upserts } = setup({ shortFilter: true });
  const result = await importer.importMessages([human('a', 'alice', 10, { content: 'hi' })], { channel });
  assert.equal(result.insertedRaw, 1);
  assert.equal(result.kept, 0);
  assert.equal(upserts.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('a dry run reports counts and writes nothing, bot messages included', async () => {
  const { importer, db, upserts } = setup({ shortFilter: true });
  const messages = [
    human('a', 'alice', 10), human('b', 'bob', 20, { content: 'hi' }), botMessage('b1', 'bob', 30),
  ];
  const result = await importer.importMessages(messages, { channel, dryRun: true });
  assert.equal(result.insertedRaw, 2);
  assert.equal(result.kept, 1);
  assert.equal(result.botMessages.imported, 1);
  assert.equal(upserts.length, 0);
  ['messages', 'filtered_messages', 'bot_messages'].forEach((table) => {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  });
});

test('run reads the history with before and limit and adds the fetched count', async () => {
  const seen = [];
  const { importer } = setup({
    readAll: async (ch, options) => {
      seen.push([ch, options]);
      return [human('a', 'alice', 10)];
    },
  });
  const result = await importer.run({ channel, before: '99', limit: 5 });
  assert.deepEqual(seen, [[channel, { before: '99', limit: 5 }]]);
  assert.equal(result.fetched, 1);
  assert.equal(result.insertedRaw, 1);
});

test('a read failure rejects before anything is written', async () => {
  const { importer, db } = setup({ readAll: async () => { throw new Error('page failed'); } });
  await assert.rejects(importer.run({ channel }), /page failed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});
