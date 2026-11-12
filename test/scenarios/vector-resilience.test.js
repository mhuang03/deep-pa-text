import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';
import { FAKE_DIMENSIONS } from '../support/fakes/chroma.js';

const DAY = 86_400_000;
const CHROMA_TIMEOUT_MS = 30_000;
const FAILURE_COOLDOWN_MS = 60_000;
const REPAIR_INTERVAL_MS = 600_000;
const HELLO = 'hello there friends';
const MESSAGES = 'message_embeddings';
const REPLIES = 'message_reply_embeddings';
// The revive tick shares the repair interval; pushing it out (within the timer range) keeps these tests about vectors only.
const NO_REVIVE = { revive: { checkIntervalMs: 2_000_000_000 } };

const newWorld = async (t, options = {}) => {
  const config = { ...NO_REVIVE, embedding: { dimensions: FAKE_DIMENSIONS }, ...options.config };
  const world = await createWorld({ ...options, config });
  t.after(() => world.close());
  return world;
};

const flush = async (world) => {
  for (let i = 0; i < 10; i += 1) await world.settle();
};

// A handler stuck on a hung Chroma never settles, so the event is emitted without awaiting it.
const yieldMacrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const emitStuck = async (world, fields) => {
  const message = world.addHistory(fields);
  world.discord.client.emit(Events.MessageCreate, message);
  await yieldMacrotasks();
  return message;
};

// world.advance would wait for the stuck handler, so a hung step is advanced on the mocked clock directly.
const tickStuck = async (ms) => {
  mock.timers.tick(ms);
  await yieldMacrotasks();
};

const count = (world, table) => world.sqlite.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
// Node's own experimental-feature notices also land in the error log; handler errors carry an Error.
const errors = (world) => world.logs.error.filter((args) => args.some((a) => /^\w*Error: /.test(String(a))));
const warnings = (world) => world.logs.warn.map((args) => String(args[0]));
const missingWarnings = (world) => warnings(world).filter((text) => /repaired automatically/.test(text));
const ids = (world, name) => [...world.chroma.collection(name).rows.keys()].sort();

test('a hung Chroma during live ingest times out, keeps the SQLite rows and warns once', async (t) => {
  const world = await newWorld(t);
  world.chroma.hang(true);
  await emitStuck(world, { id: 'm1', author: 'alice', content: HELLO });
  await world.advance(CHROMA_TIMEOUT_MS);
  assert.equal(count(world, 'messages'), 1);
  assert.equal(count(world, 'filtered_messages'), 1);
  assert.deepEqual(errors(world), []);
  assert.equal(missingWarnings(world).length, 1);
  assert.equal(world.chroma.collection(MESSAGES).rows.size, 0);
});

test('a rejecting Chroma during live ingest is tolerated without waiting', async (t) => {
  const world = await newWorld(t);
  world.chroma.failCollection(MESSAGES, new Error('chroma rejected'));
  await world.emitMessage({ id: 'm1', author: 'alice', content: HELLO });
  assert.equal(count(world, 'filtered_messages'), 1);
  assert.deepEqual(errors(world), []);
  assert.equal(missingWarnings(world).length, 1);
});

test('an embedding API rejection (429) during live ingest is tolerated', async (t) => {
  const world = await newWorld(t);
  world.chroma.embedder.setFailing(new Error('429 too many requests'));
  await world.emitMessage({ id: 'm1', author: 'alice', content: HELLO });
  assert.equal(count(world, 'filtered_messages'), 1);
  assert.deepEqual(errors(world), []);
  assert.equal(missingWarnings(world).length, 1);
});

test('an edit and a burst of failures warn once per repair interval', async (t) => {
  const world = await newWorld(t);
  world.chroma.failCollection(MESSAGES, new Error('chroma rejected'));
  const first = await world.emitMessage({ id: 'm1', author: 'alice', content: HELLO });
  await world.emitMessage({ id: 'm2', author: 'bob', content: 'another message here' });
  await world.emitEdit(first, { content: 'an edited message here' });
  assert.equal(count(world, 'message_revisions'), 1);
  assert.equal(missingWarnings(world).length, 1);
});

test('an outage, the recovery and the next repair tick add exactly the missing vectors and clear the debt', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  world.chroma.failCollection(MESSAGES, new Error('chroma rejected'));
  const parent = await world.emitMessage({ id: 'm1', author: 'alice', content: HELLO });
  await world.emitMessage({ id: 'm2', author: 'bob', content: 'bob answers the parent', reference: parent.id });
  assert.equal(world.chroma.collection(MESSAGES).rows.size, 0);
  world.chroma.failCollection(MESSAGES, null);
  await world.advance(REPAIR_INTERVAL_MS);
  await flush(world);
  assert.deepEqual(ids(world, MESSAGES), ['m1', 'm2']);
  assert.deepEqual(ids(world, REPLIES), ['m2']);
  assert.ok(world.logs.log.some((args) => /Vector repair checked/.test(String(args[0]))));
  const collection = world.chroma.collection(MESSAGES);
  let reads = 0;
  const original = collection.get.bind(collection);
  collection.get = (...args) => {
    reads += 1;
    return original(...args);
  };
  await world.advance(REPAIR_INTERVAL_MS);
  await flush(world);
  assert.equal(reads, 0);
});

test('a repair that fails keeps the debt and the next tick retries it', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  world.chroma.failCollection(MESSAGES, new Error('chroma rejected'));
  await world.emitMessage({ id: 'm1', author: 'alice', content: HELLO });
  await world.advance(REPAIR_INTERVAL_MS);
  await flush(world);
  assert.ok(warnings(world).some((text) => /Vector repair failed/.test(text)));
  assert.equal(world.chroma.collection(MESSAGES).rows.size, 0);
  world.chroma.failCollection(MESSAGES, null);
  await world.advance(REPAIR_INTERVAL_MS);
  await flush(world);
  assert.deepEqual(ids(world, MESSAGES), ['m1']);
});

const seedSqlite = (container, { id, timestamp }) => {
  const record = { id, author: 'alice', content: `old message ${id}`, timestamp, reference: null };
  container.messageStore.insertRaw(record);
  container.messageStore.insertFiltered(record, { inferReference: false });
};

test('a restart repairs vectors missing from the last 7 days and leaves older rows for the manual sync', async (t) => {
  const world = await newWorld(t, {
    preload: (container) => {
      seedSqlite(container, { id: 'recent', timestamp: BASE_TIME - DAY });
      seedSqlite(container, { id: 'ancient', timestamp: BASE_TIME - 10 * DAY });
    },
  });
  await world.ready();
  await flush(world);
  assert.deepEqual(ids(world, MESSAGES), ['recent']);
  const manual = await world.container.vectorSync.run({});
  assert.equal(manual.addedMessages, 1);
  assert.deepEqual(ids(world, MESSAGES), ['ancient', 'recent']);
});

test('retrieval timing out mid-reply fails closed: nothing is sent, the error is logged, later messages work', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.seed([{ id: 's1', author: 'bob', content: 'an earlier message here', timestamp: BASE_TIME - 1000, reference: null }]);
  world.chroma.hang(true);
  const stuck = await emitStuck(world, { id: 'm1', author: 'alice', content: HELLO });
  await tickStuck(CHROMA_TIMEOUT_MS);
  await tickStuck(CHROMA_TIMEOUT_MS);
  await world.settle();
  assert.deepEqual(stuck.replies, []);
  assert.deepEqual(world.discord.channel.sent, []);
  assert.ok(errors(world).some((args) => args.some((a) => /timed out/.test(String(a)))));
  world.chroma.hang(false);
  await world.advance(FAILURE_COOLDOWN_MS);
  const later = await world.emitMessage({ id: 'm2', author: 'carol', content: 'a later message here' });
  assert.equal(later.replies.length, 1);
});

test('a backfill style batch whose vector write fails still rejects with a vector error', async (t) => {
  const world = await newWorld(t);
  world.chroma.failCollection(MESSAGES, new Error('chroma rejected'));
  const record = { id: 'b1', author: 'alice', content: HELLO, timestamp: BASE_TIME, reference: null };
  await assert.rejects(world.container.ingest.recordMessages([{ record }]), (error) => error.isVectorError === true);
  assert.equal(count(world, 'filtered_messages'), 1);
});

test('shutdown abandons a repair that is still running, naming it', async (t) => {
  const world = await newWorld(t, {
    preload: (container) => seedSqlite(container, { id: 'recent', timestamp: BASE_TIME - DAY }),
  });
  world.chroma.hang(true);
  await world.ready();
  await flush(world);
  await world.container.lifecycle.shutdown({ reason: 'test' });
  assert.ok(warnings(world).some((text) => /abandoning 1 handler\(s\): vectorStartupRepair/.test(text)));
});
