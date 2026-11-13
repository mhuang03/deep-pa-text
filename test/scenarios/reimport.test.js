import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { buildContainer, defaultClock } from '../../src/container.js';
import { openDatabase } from '../../src/storage/database.js';
import { createMetaStore } from '../../src/storage/metaStore.js';
import { createDiscordClient } from '../../src/discord/client.js';
import { createDatabaseSwitch } from '../../src/backfill/databaseSwitch.js';
import { createReimporter, buildGeneration } from '../../src/backfill/reimport.js';
import { REPLY_LINK_PREFIX } from '../../src/discord/webhookDelivery.js';
import { createFakeDiscord } from '../support/fakes/discord.js';
import { createFakeChroma, fakeEmbed, FAKE_DIMENSIONS } from '../support/fakes/chroma.js';
import { createFakeOpenAI } from '../support/fakes/llm.js';
import { createFakeGifs } from '../support/fakes/gifs.js';
import { BASE_TIME, ENV, PING_CACHE, USERS } from '../support/fixtures.js';

const MINUTE = 60_000;
const BOT_ID = 'bot-user';
const FENCE_TEXT = 'the quick brown fox jumps over the fence';
const GIF_TEXT = 'check this out <gif! dancing cat> wow';
const at = (minutes) => BASE_TIME - 5 * 3_600_000 + minutes * MINUTE;
const GENERATION = buildGeneration(BASE_TIME);
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop };
const fileBytes = (file) => fs.readFileSync(file);

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-reimport-scn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakes = {
    discord: createFakeDiscord(), chroma: createFakeChroma(), llm: createFakeOpenAI(), gifs: createFakeGifs(),
  };
  fakes.discord.state.autoReady = true;
  const vendor = {
    Client: fakes.discord.Client,
    ChromaClient: fakes.chroma.ChromaClient,
    OpenAIEmbeddingFunction: fakes.chroma.OpenAIEmbeddingFunction,
    OpenAI: fakes.llm.OpenAI,
    GiphyFetch: fakes.gifs.GiphyFetch,
    fetch: fakes.gifs.fetch,
  };
  const base = loadConfig(ENV);
  const databasePath = path.join(dir, 'messages.db');
  const config = {
    ...base,
    storage: { ...base.storage, databasePath },
    embedding: { ...base.embedding, dimensions: FAKE_DIMENSIONS },
  };
  const clock = { ...defaultClock(), now: () => BASE_TIME, sleep: async () => {} };
  const data = { users: USERS, pingCache: PING_CACHE };
  return { dir, fakes, vendor, config, clock, data, databasePath };
};

const build = (env) => buildContainer({
  config: env.config, vendor: env.vendor, data: env.data, clock: env.clock, logger,
});

const rec = (id, author, content, minutes, reference = null) => ({
  id, author, content, timestamp: at(minutes), reference,
});

// The old database: filled through the normal stores, plus rows shaped like the pre-fix code wrote them.
const seedOld = async (env) => {
  const old = build(env);
  await old.vectorStore.connect();
  await old.ingest.recordMessages([
    { record: rec('h1', 'alice', FENCE_TEXT, 1) },
    { record: rec('h2', 'bob', GIF_TEXT, 2) },
    { record: rec('gone', 'carol', 'this message was deleted from discord', 3) },
    { record: rec('edit', 'dave', 'original text of the message', 4) },
  ]);
  old.messageStore.insertRaw(rec('raw1', 'dave', 'a long enough message that was never kept', 5));
  old.messageStore.insertFiltered(rec('h4', 'alice', 'replying to the bot message there', 7, 'h1'), {});
  old.botMessageStore.insert({
    id: 'b1', persona: 'carol', content: 'recorded words <gif! wave>', timestamp: at(6), reference: 'h1', trigger: 'reply',
  });
  old.profileStore.record({ username: 'bob', displayName: 'bobby', observedAt: 5 });
  old.db.close();
};

const seedChannel = (env) => {
  const { channel, addHistory } = { channel: env.fakes.discord.state.channel, addHistory: env.fakes.discord.state.addHistory };
  const hook = channel.webhooks.add({ name: 'deep-pa-text' });
  const bot = { authorId: BOT_ID, bot: true, author: 'deep-pa-text' };
  addHistory({ id: 'h1', author: 'alice', content: FENCE_TEXT, timestamp: at(1) });
  addHistory({ id: 'h2', author: 'bob', content: GIF_TEXT, timestamp: at(2) });
  addHistory({ id: 'edit', author: 'dave', content: 'edited text of the message', timestamp: at(4) });
  addHistory({ id: 'raw1', author: 'dave', content: 'a long enough message that was never kept', timestamp: at(5) });
  addHistory({ id: 'b1', ...bot, content: 'rendered https://gif.test/wave.gif', timestamp: at(6), embeds: [{ author: { name: 'carol' } }], reference: 'h1' });
  addHistory({ id: 'h4', author: 'alice', content: 'replying to the bot message there', timestamp: at(7), reference: 'b1' });
  addHistory({ id: 'b2', ...bot, content: 'older bot words', timestamp: at(8), embeds: [{ author: { name: 'bob' } }] });
  addHistory({
    id: 'w1', author: 'bobby', bot: true, authorId: hook.id, webhookId: hook.id,
    content: `${REPLY_LINK_PREFIX}https://discord.test/channels/1/2/h2\nwebhook words`, timestamp: at(9),
  });
  addHistory({ id: 'b3', ...bot, content: 'nobody knows who said this', timestamp: at(10) });
  addHistory({ id: 'p1', author: 'Proxy', authorId: 'proxy', bot: true, content: 'another application', timestamp: at(11) });
};

const makeReimporter = (env, { fsOverrides = {} } = {}) => {
  const realFs = { ...fs, ...fsOverrides };
  return createReimporter({
    config: env.config,
    vendor: env.vendor,
    data: env.data,
    clock: env.clock,
    logger,
    fs: realFs,
    buildContainer,
    createDiscordClient,
    databaseSwitch: createDatabaseSwitch({ fs: realFs, openDatabase, createMetaStore, logger }),
    openDatabase,
  });
};

const withDb = (file, fn) => {
  const db = openDatabase(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const rows = (file, sql, ...params) => withDb(file, (db) => db.prepare(sql).all(...params).map((r) => ({ ...r })));
const metaOf = (file, key) => withDb(file, (db) => createMetaStore({ db }).get(key));

const prepared = async (t) => {
  const env = setup(t);
  await seedOld(env);
  seedChannel(env);
  return env;
};

const crashAt = (name) => ({
  [name]: (...args) => {
    throw Object.assign(new Error(`crash at ${name}`), { args });
  },
});

test('without --yes nothing changes on disk or in Chroma', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  const upserts = env.fakes.chroma.state.collection('message_embeddings').upserts.length;
  const embeddings = env.fakes.chroma.state.embeddingCalls;
  const report = await makeReimporter(env).run({});
  assert.equal(report.applied, false);
  assert.deepEqual(fileBytes(env.databasePath), bytes);
  assert.deepEqual(fs.readdirSync(env.dir), ['messages.db']);
  assert.equal(env.fakes.chroma.state.collection('message_embeddings').upserts.length, upserts);
  assert.equal(env.fakes.chroma.state.embeddingCalls, embeddings);
  assert.deepEqual(
    { fetched: report.fetched, humans: report.humans, ownBot: report.ownBot, otherBots: report.otherBots },
    { fetched: 10, humans: 5, ownBot: 4, otherBots: 1 },
  );
  assert.equal(report.wouldKeep, 5);
});

test('an applied run backs up, replaces and re-imports under a new generation', async (t) => {
  const env = await prepared(t);
  const before = fileBytes(env.databasePath);
  const oldRows = new Map(env.fakes.chroma.state.collection('message_embeddings').rows);
  const report = await makeReimporter(env).run({ yes: true });
  const { databasePath } = env;
  assert.equal(report.applied, true);
  assert.equal(report.generation, GENERATION);
  assert.deepEqual(fileBytes(`${databasePath}.old`), before);
  assert.ok(!fs.existsSync(`${databasePath}.new`));
  const ids = rows(databasePath, 'SELECT id FROM messages ORDER BY id').map((r) => r.id);
  assert.deepEqual(ids, ['edit', 'h1', 'h2', 'h4', 'raw1']);
  assert.equal(rows(databasePath, "SELECT content FROM messages WHERE id = 'edit'")[0].content, 'edited text of the message');
  assert.equal(rows(databasePath, "SELECT COUNT(*) AS n FROM filtered_messages WHERE id = 'raw1'")[0].n, 1);
  assert.equal(rows(databasePath, "SELECT reference FROM filtered_messages WHERE id = 'h4'")[0].reference, null);
  assert.equal(metaOf(databasePath, 'chroma_generation'), GENERATION);
  assert.equal(metaOf(databasePath, 'reimport_started_at'), String(BASE_TIME));
  assert.equal(metaOf(databasePath, 'reimport_completed_at'), String(BASE_TIME));
  const chroma = env.fakes.chroma.state;
  const newMessages = chroma.collection(`message_embeddings_${GENERATION}`);
  assert.deepEqual([...newMessages.rows.keys()].sort(), ['edit', 'h1', 'h2', 'h4', 'raw1']);
  [...newMessages.rows.values()].forEach((row) => assert.equal(typeof row.metadata.has_gif, 'boolean'));
  assert.equal(newMessages.rows.get('h2').metadata.has_gif, true);
  assert.ok(chroma.collection(`message_reply_embeddings_${GENERATION}`));
  assert.deepEqual(chroma.collection('message_embeddings').rows, oldRows);
});

test('the new reply collection holds the human reply with the parent embedding and has_gif, and none for a reply to a bot message', async (t) => {
  const env = await prepared(t);
  env.fakes.discord.state.addHistory({
    id: 'h5', author: 'bob', content: 'a direct reply <gif! nod> about the fence', timestamp: at(12), reference: 'h1',
  });
  await makeReimporter(env).run({ yes: true });
  const chroma = env.fakes.chroma.state;
  const replies = chroma.collection(`message_reply_embeddings_${GENERATION}`);
  assert.ok(replies.rows.has('h5'));
  const row = replies.rows.get('h5');
  assert.equal(row.document, 'a direct reply <gif! nod> about the fence');
  assert.deepEqual(row.embedding, fakeEmbed(FENCE_TEXT));
  assert.deepEqual(row.embedding, chroma.collection(`message_embeddings_${GENERATION}`).rows.get('h1').embedding);
  assert.equal(row.metadata.has_gif, true);
  assert.equal(row.metadata.author, 'bob');
  assert.equal(replies.rows.has('h4'), false);
  assert.equal(rows(env.databasePath, "SELECT reference FROM filtered_messages WHERE id = 'h5'")[0].reference, 'h1');
});

test('bot messages keep the backup\'s attribution, else fall back, else are counted as unattributed', async (t) => {
  const env = await prepared(t);
  const report = await makeReimporter(env).run({ yes: true });
  const bots = rows(env.databasePath, 'SELECT id, persona, content, reference, trigger FROM bot_messages ORDER BY id');
  assert.deepEqual(bots, [
    { id: 'b1', persona: 'carol', content: 'recorded words <gif! wave>', reference: 'h1', trigger: 'reply' },
    { id: 'b2', persona: 'bob', content: 'older bot words', reference: null, trigger: 'imported' },
    { id: 'w1', persona: 'bob', content: 'webhook words', reference: 'h2', trigger: 'imported' },
  ]);
  assert.equal(report.imported.botMessages, 3);
  assert.equal(report.imported.unattributedBotMessages, 1);
  assert.equal(rows(env.databasePath, "SELECT COUNT(*) AS n FROM user_profiles WHERE display_name = 'bobby'")[0].n, 1);
});

test('the comparison counts what was deleted or edited since the backup', async (t) => {
  const env = await prepared(t);
  const { comparison } = await makeReimporter(env).run({ yes: true });
  assert.equal(comparison.missingInNew, 1);
  assert.equal(comparison.changedContent, 1);
  assert.equal(comparison.old.raw, 5);
  assert.equal(comparison.new.raw, 5);
  assert.equal(comparison.old.botMessages, 1);
  assert.equal(comparison.new.botMessages, 3);
});

test('a raw row the old code never put in the corpus gets a corpus row', async (t) => {
  const env = await prepared(t);
  assert.equal(rows(env.databasePath, "SELECT COUNT(*) AS n FROM filtered_messages WHERE id = 'raw1'")[0].n, 0);
  await makeReimporter(env).run({ yes: true });
  assert.equal(rows(env.databasePath, "SELECT COUNT(*) AS n FROM filtered_messages WHERE id = 'raw1'")[0].n, 1);
});

test('after the run the normal container uses the new generation and the backup the old names', async (t) => {
  const env = await prepared(t);
  await makeReimporter(env).run({ yes: true });
  const fresh = build(env);
  await fresh.vectorStore.connect();
  await fresh.vectorStore.upsertMessages([{ id: 'probe', author: 'a', content: 'probe', timestamp: 1, reference: null }]);
  assert.ok(env.fakes.chroma.state.collection(`message_embeddings_${GENERATION}`).rows.has('probe'));
  assert.ok(!env.fakes.chroma.state.collection('message_embeddings').rows.has('probe'));
  fresh.db.close();
  const backupConfig = { ...env.config, storage: { ...env.config.storage, databasePath: `${env.databasePath}.old` } };
  const restored = build({ ...env, config: backupConfig });
  await restored.vectorStore.connect();
  await restored.vectorStore.upsertMessages([{ id: 'probe2', author: 'a', content: 'probe two', timestamp: 1, reference: null }]);
  assert.ok(env.fakes.chroma.state.collection('message_embeddings').rows.has('probe2'));
  restored.db.close();
});

test('a leftover .old, a journal file or a missing database block before Discord is contacted', async (t) => {
  const old = await prepared(t);
  fs.writeFileSync(`${old.databasePath}.old`, 'earlier backup');
  await assert.rejects(makeReimporter(old).run({ yes: true }), (e) => e.message.includes(`${old.databasePath}.old`));
  const journal = await prepared(t);
  fs.writeFileSync(`${journal.databasePath}-journal`, '');
  await assert.rejects(makeReimporter(journal).run({ yes: true }), /-journal/);
  const missing = setup(t);
  seedChannel(missing);
  await assert.rejects(makeReimporter(missing).run({ yes: true }), /does not exist/);
  [old, journal, missing].forEach((env) => assert.deepEqual(env.fakes.discord.state.loginTokens, []));
  assert.equal(fs.readFileSync(`${old.databasePath}.old`, 'utf8'), 'earlier backup');
});

test('a history fetch that keeps failing aborts with nothing changed', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  env.fakes.discord.state.channel.messages.setFailing(new Error('discord unavailable'));
  await assert.rejects(makeReimporter(env).run({ yes: true }), /discord unavailable/);
  assert.deepEqual(fileBytes(env.databasePath), bytes);
  assert.deepEqual(fs.readdirSync(env.dir), ['messages.db']);
});

test('a crash after prepare leaves the database untouched and a fresh run refuses', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  await assert.rejects(makeReimporter(env, { fsOverrides: crashAt('linkSync') }).run({ yes: true }), /crash at linkSync/);
  assert.deepEqual(fileBytes(env.databasePath), bytes);
  assert.ok(fs.existsSync(`${env.databasePath}.new`));
  await assert.rejects(makeReimporter(env).run({ yes: true }), /Move the \.new file/);
  await assert.rejects(makeReimporter(env).run({ yes: true, resume: true }), /Move the \.new file/);
  assert.equal(rows(env.databasePath, 'SELECT COUNT(*) AS n FROM messages')[0].n, 5);
});

test('a crash after the backup is finished by --resume', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  await assert.rejects(makeReimporter(env, { fsOverrides: crashAt('renameSync') }).run({ yes: true }), /crash at renameSync/);
  assert.deepEqual(fileBytes(env.databasePath), bytes);
  assert.deepEqual(fileBytes(`${env.databasePath}.old`), bytes);
  await assert.rejects(makeReimporter(env).run({ yes: true }), /--resume/);
  const report = await makeReimporter(env).run({ yes: true, resume: true });
  assert.equal(report.applied, true);
  assert.equal(metaOf(env.databasePath, 'reimport_completed_at'), String(BASE_TIME));
  assert.deepEqual(fileBytes(`${env.databasePath}.old`), bytes);
});

test('a crash after the swap is finished by --resume', async (t) => {
  const env = await prepared(t);
  // Chroma answers the preflight and goes down before the import connects, after the swap.
  let beats = 0;
  const Reachable = env.vendor.ChromaClient;
  env.vendor.ChromaClient = class extends Reachable {
    async heartbeat() {
      beats += 1;
      if (beats === 2) throw new Error('chroma down');
      return super.heartbeat();
    }
  };
  await assert.rejects(makeReimporter(env).run({ yes: true }), /chroma down/);
  assert.equal(metaOf(env.databasePath, 'reimport_completed_at'), null);
  assert.equal(rows(env.databasePath, 'SELECT COUNT(*) AS n FROM messages')[0].n, 0);
  const report = await makeReimporter(env).run({ yes: true, resume: true });
  assert.equal(report.state, 'in-progress');
  assert.equal(rows(env.databasePath, 'SELECT COUNT(*) AS n FROM messages')[0].n, 5);
});

test('when hard links are unsupported the backup is a copy, and an existing .old still refuses', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  const exdev = { linkSync: () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); } };
  await makeReimporter(env, { fsOverrides: exdev }).run({ yes: true });
  assert.deepEqual(fileBytes(`${env.databasePath}.old`), bytes);
  const other = await prepared(t);
  fs.writeFileSync(`${other.databasePath}.old`, 'keep');
  await assert.rejects(makeReimporter(other, { fsOverrides: exdev }).run({ yes: true }), /\.old/);
  assert.equal(fs.readFileSync(`${other.databasePath}.old`, 'utf8'), 'keep');
});

test('a Chroma batch rejection leaves the run in progress and --resume repairs the vectors', async (t) => {
  const env = await prepared(t);
  env.fakes.chroma.state.failCollection(`message_embeddings_${GENERATION}`, new Error('batch rejected'), ['upsert']);
  await assert.rejects(makeReimporter(env).run({ yes: true }), /batch rejected/);
  assert.equal(metaOf(env.databasePath, 'reimport_completed_at'), null);
  const collection = env.fakes.chroma.state.collection(`message_embeddings_${GENERATION}`);
  assert.equal(collection.rows.size, 0);
  env.fakes.chroma.state.failCollection(`message_embeddings_${GENERATION}`, null);
  const report = await makeReimporter(env).run({ yes: true, resume: true });
  assert.ok(report.sync.addedMessages > 0);
  assert.deepEqual([...collection.rows.keys()].sort(), ['edit', 'h1', 'h2', 'h4', 'raw1']);
  assert.equal(metaOf(env.databasePath, 'reimport_completed_at'), String(BASE_TIME));
  await assert.rejects(makeReimporter(env).run({ yes: true, resume: true }), /Nothing to resume/);
});

const interruptedCopy = () => ({
  linkSync: () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); },
  copyFileSync: (from, to) => {
    fs.writeFileSync(to, fs.readFileSync(from).subarray(0, 100));
    throw new Error('copy interrupted');
  },
});

test('an interrupted copy-path backup leaves .old.tmp, blocks the next run and never touches the database', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  await assert.rejects(makeReimporter(env, { fsOverrides: interruptedCopy() }).run({ yes: true }), /copy interrupted/);
  assert.deepEqual(fileBytes(env.databasePath), bytes);
  assert.equal(fs.existsSync(`${env.databasePath}.old`), false);
  assert.ok(fs.existsSync(`${env.databasePath}.old.tmp`));
  await assert.rejects(makeReimporter(env).run({ yes: true }), /incomplete backup/);
  await assert.rejects(makeReimporter(env).run({ yes: true, resume: true }), /incomplete backup/);
  assert.deepEqual(fileBytes(env.databasePath), bytes);
});

test('--resume with a truncated .old next to .new is refused and the database stays', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  await assert.rejects(makeReimporter(env, { fsOverrides: crashAt('renameSync') }).run({ yes: true }), /crash at renameSync/);
  fs.rmSync(`${env.databasePath}.old`);
  fs.writeFileSync(`${env.databasePath}.old`, bytes.subarray(0, bytes.length - 10));
  await assert.rejects(
    makeReimporter(env).run({ yes: true, resume: true }),
    /not identical.*original database is intact.*without --resume/s,
  );
  assert.deepEqual(fileBytes(env.databasePath), bytes);
  assert.ok(fs.existsSync(`${env.databasePath}.new`));
});

test('--resume with an identical (copied) .old proceeds', async (t) => {
  const env = await prepared(t);
  const bytes = fileBytes(env.databasePath);
  await assert.rejects(makeReimporter(env, { fsOverrides: crashAt('renameSync') }).run({ yes: true }), /crash at renameSync/);
  fs.rmSync(`${env.databasePath}.old`);
  fs.copyFileSync(env.databasePath, `${env.databasePath}.old`);
  const report = await makeReimporter(env).run({ yes: true, resume: true });
  assert.equal(report.applied, true);
  assert.deepEqual(fileBytes(`${env.databasePath}.old`), bytes);
});

test('Chroma down before an applied run: the preflight refuses and nothing is fetched or changed', async (t) => {
  const env = await prepared(t);
  const before = fs.readFileSync(env.databasePath);
  env.fakes.chroma.state.failHeartbeat(new Error('connect ECONNREFUSED'));
  await assert.rejects(makeReimporter(env).run({ yes: true }), /Preflight failed; nothing was fetched or changed/);
  assert.equal(env.fakes.discord.state.channel.messages.calls.length, 0);
  assert.deepEqual(fs.readFileSync(env.databasePath), before);
  assert.equal(fs.existsSync(`${env.databasePath}.old`), false);
  assert.equal(fs.existsSync(`${env.databasePath}.new`), false);
});
