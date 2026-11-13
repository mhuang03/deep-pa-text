import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../../src/config.js';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createReimporter, buildGeneration } from '../../../src/backfill/reimport.js';
import { createFakeDiscord } from '../../support/fakes/discord.js';
import { ENV, USERS, PING_CACHE, BASE_TIME } from '../../support/fixtures.js';

const config = loadConfig(ENV);
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop };
const BOT_ID = 'bot-user';

const seedOld = (file) => {
  const db = openDatabase(file);
  db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('h1','alice','the quick brown fox jumps',1),('gone','bob','deleted since',2)");
  db.exec("INSERT INTO bot_messages (id, persona, content, timestamp, reference, trigger) VALUES ('b1','carol','old words <gif! x>',3,'h1','reply')");
  db.exec("INSERT INTO user_profiles (username, user_id, display_name, avatar_url, observed_at) VALUES ('bob','u2','Bob',NULL,7)");
  db.close();
};

const setup = (t, {
  status = { state: 'ready', reason: null }, historyError = null, verifyError = null, heartbeatError = null,
} = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-reimport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'messages.db');
  seedOld(databasePath);
  fs.copyFileSync(databasePath, `${databasePath}.old`);
  const discord = createFakeDiscord();
  discord.state.autoReady = true;
  discord.state.addHistory({ id: 'h1', author: 'alice', content: 'the quick brown fox jumps over', timestamp: 10 });
  discord.state.addHistory({ id: 'b1', author: 'deep-pa-text', authorId: BOT_ID, bot: true, content: 'new words', timestamp: 11 });
  discord.state.addHistory({ id: 'p1', author: 'Proxy', authorId: 'proxy', bot: true, content: 'other bot says hi', timestamp: 12 });
  if (historyError) discord.state.channel.messages.setFailing(historyError);
  const events = [];
  const calls = { importMessages: [], recorded: [], sync: 0, meta: new Map() };
  const newDb = openDatabase(':memory:');
  const container = {
    db: newDb,
    messageStore: createMessageStore({ db: newDb, config }),
    vectorStore: { connect: async () => events.push('connect-vectors') },
    profileStore: { record: (row) => calls.recorded.push(row) },
    historyImporter: {
      importMessages: async (messages, options) => {
        events.push('import');
        // The archive handle is closed once the import returns, so the lookup is exercised now.
        calls.importMessages.push({
          messages, options, known: options.botMessageLookup('b1'), unknown: options.botMessageLookup('nope'),
        });
        return { insertedRaw: 1, kept: 1, botMessages: { imported: 1, unattributed: 2, skippedEmpty: 3 } };
      },
    },
    vectorSync: { run: async () => { events.push('sync'); calls.sync += 1; return { checked: 1 }; } },
    metaStore: {
      get: (key) => (key === 'chroma_generation' ? 'g-from-meta' : null),
      setIfAbsent: (key, value) => { events.push(`meta:${key}`); calls.meta.set(key, value); return true; },
    },
  };
  const databaseSwitch = {
    inspect: () => { events.push('inspect'); return status; },
    prepare: (db, options) => { events.push('prepare'); calls.prepare = options; },
    backup: () => events.push('backup'),
    swap: () => events.push('swap'),
    verifyBackup: () => { events.push('verify'); if (verifyError) throw verifyError; },
  };
  const reimporter = createReimporter({
    config: { ...config, storage: { ...config.storage, databasePath } },
    vendor: {
      Client: discord.Client,
      ChromaClient: class {
        async heartbeat() { events.push('preflight'); if (heartbeatError) throw heartbeatError; }
      },
      OpenAIEmbeddingFunction: class {
        async generate() { return [Array(config.embedding.dimensions).fill(0)]; }
      },
    },
    data: { users: USERS, pingCache: PING_CACHE },
    clock: { now: () => BASE_TIME, sleep: async () => {}, setTimeout, clearTimeout },
    logger,
    fs,
    buildContainer: (options) => { events.push('build'); calls.build = options; return container; },
    createDiscordClient: (Client, options) => { calls.clientOptions = options; return new Client(options); },
    databaseSwitch,
    openDatabase,
  });
  return { reimporter, events, calls, discord, container, databasePath };
};

test('buildGeneration is g plus the UTC timestamp of the run', () => {
  assert.equal(buildGeneration(Date.parse('2026-11-12T18:04:05Z')), 'g20261112180405');
});

test('a dry run reads and reports without switching, building or syncing anything', async (t) => {
  const { reimporter, events, calls, discord } = setup(t);
  const report = await reimporter.run({});
  assert.equal(report.applied, false);
  assert.deepEqual(events, ['inspect']);
  assert.deepEqual(
    { fetched: report.fetched, humans: report.humans, ownBot: report.ownBot, otherBots: report.otherBots, wouldKeep: report.wouldKeep },
    { fetched: 3, humans: 1, ownBot: 1, otherBots: 1, wouldKeep: 1 },
  );
  assert.equal(report.generation, buildGeneration(BASE_TIME));
  assert.deepEqual(calls.clientOptions, { cacheMessages: false });
  assert.equal(discord.state.destroyed, 1);
  assert.equal(report.comparison, null);
});

test('applying switches first, then builds, carries over, imports, syncs and only then completes', async (t) => {
  const { reimporter, events, calls, discord } = setup(t);
  const report = await reimporter.run({ yes: true });
  assert.deepEqual(events, [
    'inspect', 'preflight', 'prepare', 'backup', 'swap', 'build', 'connect-vectors', 'import', 'sync', 'meta:reimport_completed_at',
  ]);
  assert.deepEqual(calls.prepare, { generation: buildGeneration(BASE_TIME), startedAt: BASE_TIME });
  assert.equal(calls.meta.get('reimport_completed_at'), String(BASE_TIME));
  assert.equal(calls.build.client, discord.state.client);
  assert.equal(report.applied, true);
  assert.equal(report.generation, 'g-from-meta');
  assert.match(report.backupPath, /messages\.db\.old$/);
  assert.deepEqual(report.imported, {
    insertedRaw: 1, kept: 1, botMessages: 1, unattributedBotMessages: 2, skippedEmptyBotMessages: 3,
  });
  assert.deepEqual(report.sync, { checked: 1 });
  assert.equal(discord.state.destroyed, 1);
});

test('profiles are carried over and the bot-message lookup reads the backup', async (t) => {
  const { reimporter, calls, discord } = setup(t);
  await reimporter.run({ yes: true });
  assert.deepEqual(calls.recorded, [{
    username: 'bob', userId: 'u2', displayName: 'Bob', avatarURL: null, observedAt: 7,
  }]);
  const { options, messages, known, unknown } = calls.importMessages[0];
  assert.equal(messages.length, 3);
  assert.deepEqual(known, { persona: 'carol', content: 'old words <gif! x>', reference: 'h1', trigger: 'reply' });
  assert.equal(unknown, null);
  assert.equal(options.channel, discord.state.channel);
});

test('the comparison counts ids deleted and edited since the backup', async (t) => {
  const { reimporter, container } = setup(t);
  container.db.exec("INSERT INTO messages (id, author, content, timestamp) VALUES ('h1','alice','the quick brown fox jumps over',1)");
  const { comparison } = await reimporter.run({ yes: true });
  assert.deepEqual(comparison.old, { raw: 2, corpus: 0, botMessages: 1 });
  assert.deepEqual(comparison.new, { raw: 1, corpus: 0, botMessages: 0 });
  assert.equal(comparison.missingInNew, 1);
  assert.equal(comparison.changedContent, 1);
});

test('a failed history read changes nothing', async (t) => {
  const { reimporter, events, discord } = setup(t, { historyError: new Error('discord down') });
  await assert.rejects(reimporter.run({ yes: true }), /discord down/);
  assert.deepEqual(events, ['inspect', 'preflight']);
  assert.equal(discord.state.destroyed, 1);
});

test('a fresh run refuses every state but ready, with the reason or a --resume hint', async (t) => {
  const blocked = setup(t, { status: { state: 'blocked', reason: 'messages.db.old exists' } });
  await assert.rejects(blocked.reimporter.run({ yes: true }), /messages\.db\.old exists/);
  const swap = setup(t, { status: { state: 'interrupted-before-swap', reason: null } });
  await assert.rejects(swap.reimporter.run({ yes: true }), /--resume/);
  const progress = setup(t, { status: { state: 'in-progress', reason: null } });
  await assert.rejects(progress.reimporter.run({}), /--resume/);
  const backup = setup(t, { status: { state: 'interrupted-before-backup', reason: null } });
  await assert.rejects(backup.reimporter.run({ yes: true }), /Move the \.new file/);
  [blocked, swap, progress, backup].forEach(({ events, discord }) => {
    assert.deepEqual(events, ['inspect']);
    assert.equal(discord.state.client, null, 'never connected to Discord');
  });
});

test('resume requires an interrupted state and refuses ready', async (t) => {
  const ready = setup(t);
  await assert.rejects(ready.reimporter.run({ yes: true, resume: true }), /Nothing to resume/);
  const before = setup(t, { status: { state: 'interrupted-before-backup', reason: null } });
  await assert.rejects(before.reimporter.run({ resume: true, yes: true }), /Move the \.new file/);
});

test('resuming before the swap only swaps; resuming in progress switches nothing', async (t) => {
  const swap = setup(t, { status: { state: 'interrupted-before-swap', reason: null } });
  await swap.reimporter.run({ yes: true, resume: true });
  // Spec 32: the backup is verified right after inspect and again immediately before the swap.
  assert.deepEqual(swap.events.slice(0, 6), ['inspect', 'verify', 'preflight', 'verify', 'swap', 'build']);
  const progress = setup(t, { status: { state: 'in-progress', reason: null } });
  const report = await progress.reimporter.run({ yes: true, resume: true });
  assert.deepEqual(progress.events.slice(0, 3), ['inspect', 'preflight', 'build']);
  assert.equal(report.state, 'in-progress');
});

test('resuming before the swap refuses an unverifiable backup and swaps nothing', async (t) => {
  const verifyError = new Error('The backup messages.db.old is not identical to messages.db (it may be truncated); it was not trusted.');
  const swap = setup(t, { status: { state: 'interrupted-before-swap', reason: null }, verifyError });
  await assert.rejects(
    swap.reimporter.run({ yes: true, resume: true }),
    /not trusted\. The original database is intact\. Move .*messages\.db\.old away and run again without --resume/,
  );
  assert.deepEqual(swap.events, ['inspect', 'verify']);
  assert.equal(swap.discord.state.client, null, 'never connected to Discord');
});

test('a failing sync leaves the run incomplete', async (t) => {
  const { reimporter, container, calls } = setup(t);
  container.vectorSync.run = async () => { throw new Error('chroma down'); };
  await assert.rejects(reimporter.run({ yes: true }), /chroma down/);
  assert.equal(calls.meta.has('reimport_completed_at'), false);
});

test('an applied run whose preflight fails stops before Discord is contacted or anything is switched', async (t) => {
  const { reimporter, events, calls, discord } = setup(t, { heartbeatError: new Error('connect ECONNREFUSED') });
  await assert.rejects(reimporter.run({ yes: true }), /Preflight failed; nothing was fetched or changed[\s\S]*ECONNREFUSED/);
  assert.deepEqual(events, ['inspect', 'preflight']);
  assert.equal(calls.clientOptions, undefined);
  assert.equal(discord.state.destroyed, 0);
});

test('a resumed applied run is preflighted too', async (t) => {
  const { reimporter, events } = setup(t, {
    status: { state: 'in-progress', reason: null }, heartbeatError: new Error('down'),
  });
  await assert.rejects(reimporter.run({ yes: true, resume: true }), /Preflight failed/);
  assert.deepEqual(events, ['inspect', 'preflight']);
});

test('a dry run is not preflighted', async (t) => {
  const { reimporter, events } = setup(t, { heartbeatError: new Error('down') });
  const report = await reimporter.run({});
  assert.equal(report.applied, false);
  assert.deepEqual(events, ['inspect']);
});
