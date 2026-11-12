import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';
import { REPLY_LINK_PREFIX } from '../../src/discord/webhookDelivery.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const ALICE_TEXT = 'the quick brown fox jumps over the fence';
const BOT_ID = 'bot-user';

const newWorld = async (t, options = {}) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const at = (minutes) => BASE_TIME - 5 * HOUR + minutes * MINUTE;
const count = (world, table) => world.sqlite.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
const run = (world, options = {}) =>
  world.container.historyImporter.run({ channel: world.discord.channel, ...options });

const addBotEmbed = (world, id, persona, minutes, extra = {}) => world.addHistory({
  id, author: 'deep-pa-text', authorId: BOT_ID, bot: true, content: `bot words ${id}`,
  embeds: [{ author: { name: persona } }], timestamp: at(minutes), ...extra,
});

const seedHistory = (world) => {
  world.container.profileStore.record({ username: 'bob', displayName: 'bob-display', observedAt: 1 });
  const hook = world.discord.channel.webhooks.add({ name: 'deep-pa-text' });
  world.addHistory({ id: 'h1', author: 'alice', content: ALICE_TEXT, timestamp: at(1) });
  world.addHistory({ id: 'h2', author: 'bob', content: 'totally unrelated chatter here', timestamp: at(2) });
  addBotEmbed(world, 'b1', 'carol', 3, { reference: 'h1' });
  world.addHistory({
    id: 'w1', author: 'bob-display', bot: true, authorId: hook.id, webhookId: hook.id,
    content: `${REPLY_LINK_PREFIX}https://discord.test/channels/1/2/h2\nhook said this`, timestamp: at(4),
  });
  world.addHistory({ id: 'h3', author: 'dave', content: 'replying to the bot message', reference: 'b1', timestamp: at(5) });
  world.addHistory({ id: 'p1', author: 'Proxy', bot: true, authorId: 'proxy', content: 'other bot', timestamp: at(6) });
};

test('imports humans, own embed and webhook messages and drops other bots', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  const result = await run(world);
  assert.equal(result.fetched, 6);
  assert.equal(result.otherBots, 1);
  assert.deepEqual(result.botMessages, { imported: 2, alreadyStored: 0, unattributed: 0, skippedEmpty: 0 });
  assert.equal(result.insertedRaw, 3);
  assert.equal(result.kept, 3);
  const bots = world.sqlite.all('SELECT id, persona, content, reference, trigger FROM bot_messages ORDER BY id');
  assert.deepEqual(bots, [
    { id: 'b1', persona: 'carol', content: 'bot words b1', reference: 'h1', trigger: 'imported' },
    { id: 'w1', persona: 'bob', content: 'hook said this', reference: 'h2', trigger: 'imported' },
  ]);
  const reply = world.sqlite.get("SELECT reference FROM filtered_messages WHERE id = 'h3'");
  assert.equal(reply.reference, null);
  assert.equal(world.chroma.collection('message_reply_embeddings').rows.has('h3'), false);
  assert.deepEqual(world.discord.channel.messages.calls.every((c) => c.cache === false), true);
});

test('a live message similar to an imported one retrieves it', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  await run(world);
  const buckets = await world.subject.semanticSearch('alice', {
    author: 'bob', content: 'the quick brown fox jumps', timestamp: BASE_TIME, reference: null,
  });
  assert.ok(buckets.flat().some((text) => text === ALICE_TEXT));
});

test('a reply to an imported bot message continues the chain as the imported persona', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  seedHistory(world);
  await run(world);
  const reply = await world.emitMessage({ author: 'alice', content: 'why did you say that', reference: 'b1' });
  assert.equal(reply.replies.length, 1);
  const persona = reply.replies[0].embeds.at(-1).data.author.name;
  assert.equal(persona, 'carol');
  const last = world.sqlite.all("SELECT persona, trigger FROM bot_messages WHERE trigger = 'chain'");
  assert.deepEqual(last, [{ persona: 'carol', trigger: 'chain' }]);
});

test('a second run imports nothing new and makes no Chroma upserts', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  const first = await run(world);
  const upserts = world.chroma.collection('message_embeddings').upserts.length;
  const second = await run(world);
  assert.equal(second.alreadyStored, first.insertedRaw);
  assert.equal(second.insertedRaw, 0);
  assert.equal(second.botMessages.alreadyStored, 2);
  assert.equal(world.chroma.collection('message_embeddings').upserts.length, upserts);
});

test('--limit considers only the newest messages and --before only older ones', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  const limited = await run(world, { limit: 2 });
  assert.equal(limited.fetched, 2);
  assert.equal(limited.insertedRaw, 1);
  const older = await run(world, { before: 'h3' });
  assert.equal(older.fetched, 4);
});

test('a dry run changes neither SQLite nor Chroma but reports counts', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  const result = await run(world, { dryRun: true });
  assert.equal(result.insertedRaw, 3);
  assert.equal(result.kept, 3);
  assert.equal(result.botMessages.imported, 2);
  ['messages', 'filtered_messages', 'bot_messages'].forEach((table) => assert.equal(count(world, table), 0, table));
  assert.equal(world.chroma.collection('message_embeddings').rows.size, 0);
  assert.equal(world.chroma.collection('message_embeddings').upserts.length, 0);
});

test('a page that fails twice is retried after two delays', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  world.discord.channel.messages.failNext(new Error('rate limited'), { times: 2 });
  assert.equal((await run(world)).insertedRaw, 3);
  assert.deepEqual(world.sleeps, [2000, 2000]);
});

test('four page failures reject and write nothing', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  world.discord.channel.messages.failNext(new Error('still down'), { times: 4 });
  await assert.rejects(run(world), /still down/);
  assert.equal(count(world, 'messages'), 0);
  assert.equal(count(world, 'bot_messages'), 0);
});

test('a failed vector call leaves the SQLite rows and a later sync adds exactly those vectors', async (t) => {
  const world = await newWorld(t);
  seedHistory(world);
  const messages = world.chroma.collection('message_embeddings');
  messages.setFailing(new Error('chroma down'));
  await assert.rejects(run(world), /chroma down/);
  assert.equal(count(world, 'filtered_messages'), 3);
  messages.setFailing(null);
  const sync = await world.container.vectorSync.run({});
  assert.equal(sync.addedMessages, 3);
  assert.deepEqual([...messages.rows.keys()].sort(), ['h1', 'h2', 'h3']);
  assert.deepEqual(await world.container.vectorSync.run({}), {
    checked: 3, addedMessages: 0, filledMetadata: 0, addedReplies: 0, skipped: 0,
  });
});

test('the sync fills has_gif on rows seeded without it, without embedding anything', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    { id: 's1', author: 'alice', content: 'first seeded message', timestamp: at(1), reference: null },
    { id: 's2', author: 'bob', content: 'second seeded message', timestamp: at(2), reference: null },
  ]);
  const messages = world.chroma.collection('message_embeddings');
  messages.rows.forEach((row) => delete row.metadata.has_gif);
  const embeddings = new Map([...messages.rows].map(([id, row]) => [id, row.embedding]));
  const calls = world.chroma.embeddingCalls;
  const result = await world.container.vectorSync.run({});
  assert.equal(result.filledMetadata, 2);
  assert.equal(world.chroma.embeddingCalls, calls);
  messages.rows.forEach((row, id) => {
    assert.equal(row.metadata.has_gif, false);
    assert.deepEqual(row.embedding, embeddings.get(id));
  });
});
