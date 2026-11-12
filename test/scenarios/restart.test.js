import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const HELLO = 'hello there friends';

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const human = (id, timestamp, content = HELLO) => ({ id, author: 'alice', content, timestamp, reference: null });
const sent = (world) => world.discord.channel.sent;

// Seeds the database as if from a previous run, before the bot starts.
const previousRun = ({ humans = [], bots = [] }) => async (container) => {
  for (const record of humans) await container.ingest.recordMessage(record);
  bots.forEach((bot) => container.botMessageStore.insert({ persona: 'bob', content: 'earlier reply', ...bot }));
};

test('a restart 2 minutes after an auto reply is still rate limited', async (t) => {
  const world = await newWorld(t, {
    preload: previousRun({
      humans: [human('h1', BASE_TIME - 10 * MINUTE)],
      bots: [{ id: 'b1', timestamp: BASE_TIME - 2 * MINUTE, trigger: 'auto' }],
    }),
  });
  await world.ready();
  world.setRandom(0);
  const early = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(early.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
  await world.advance(3 * MINUTE + 1);
  const later = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(later.replies.length, 1);
});

test('a restart restores the rate limit from a chain or command reply, not the activity', async (t) => {
  const world = await newWorld(t, {
    preload: previousRun({
      humans: [human('h1', BASE_TIME - 5 * HOUR)],
      bots: [{ id: 'b1', timestamp: BASE_TIME - MINUTE, trigger: 'chain' }],
    }),
  });
  await world.ready();
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1, 'the chain reply does not block the due revive');
  assert.equal(world.discord.channel.sentMessages.length, 1);
});

test('the rate limit restored from a command reply blocks an immediate reply', async (t) => {
  const world = await newWorld(t, {
    preload: previousRun({
      humans: [human('h1', BASE_TIME - 5 * HOUR)],
      bots: [{ id: 'b1', timestamp: BASE_TIME - MINUTE, trigger: 'command' }],
    }),
  });
  await world.ready();
  world.setRandom(0);
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(message.replies.length, 0);
});

test('a quiet channel gets its due revive at the first check after a restart', async (t) => {
  const world = await newWorld(t, { preload: previousRun({ humans: [human('h1', BASE_TIME - 5 * HOUR)] }) });
  await world.ready();
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('after a restart where the last message is a revive, nothing revives until a human speaks', async (t) => {
  const world = await newWorld(t, {
    preload: previousRun({
      humans: [human('h1', BASE_TIME - 5 * HOUR)],
      bots: [{ id: 'b1', timestamp: BASE_TIME - HOUR, trigger: 'revive' }],
    }),
  });
  await world.ready();
  await world.advance(48 * HOUR);
  assert.deepEqual(sent(world), []);
});

test('an empty database keeps the fresh-start behaviour', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.advance(48 * HOUR);
  assert.deepEqual(sent(world), []);
});

const seedChannel = (world, entries) => entries.forEach((entry) => world.addHistory(entry));

test('messages posted while the bot was down are imported without replies, and activity follows the newest', async (t) => {
  const world = await newWorld(t, { preload: previousRun({ humans: [human('m1', BASE_TIME - HOUR)] }) });
  world.setRandom(0);
  seedChannel(world, [
    { id: 'm1', author: 'alice', content: HELLO, timestamp: BASE_TIME - HOUR },
    { id: 'm2', author: 'bob', content: 'did you see that', timestamp: BASE_TIME - 50 * MINUTE },
    { id: 'm3', author: 'carol', content: 'yes it was wild', timestamp: BASE_TIME - 40 * MINUTE },
    { id: 'm4', author: 'bob', content: 'what a night it was', timestamp: BASE_TIME - 10 * MINUTE },
  ]);
  await world.ready();
  assert.deepEqual(world.sqlite.all('SELECT id FROM messages ORDER BY timestamp').map((r) => r.id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(world.sqlite.all('SELECT id FROM filtered_messages').length, 4);
  assert.equal(world.llm.calls.length, 0);
  assert.deepEqual(sent(world), []);
  await world.advance(2 * HOUR + 10 * MINUTE);
  assert.deepEqual(sent(world), [], 'the last human message was 10 minutes before now, so no revive is due yet');
  await world.advance(HOUR);
  assert.equal(sent(world).length, 1);
});

test('a reply to a bot message posted during downtime is stored without a reference and gets no chain reply', async (t) => {
  const world = await newWorld(t, { preload: previousRun({ humans: [human('m1', BASE_TIME - HOUR)] }) });
  world.setRandom(0);
  seedChannel(world, [
    { id: 'm1', author: 'alice', content: HELLO, timestamp: BASE_TIME - HOUR },
    { id: 'b1', author: 'bot-user', authorId: 'bot-user', bot: true, content: 'a message from the bot', embeds: [{ author: { name: 'bob' } }], timestamp: BASE_TIME - 30 * MINUTE },
    { id: 'r1', author: 'alice', content: 'replying to the bot now', timestamp: BASE_TIME - 20 * MINUTE, reference: 'b1' },
  ]);
  await world.ready();
  assert.equal(world.sqlite.get('SELECT reference FROM filtered_messages WHERE id = ?', 'r1').reference, null);
  assert.equal(world.sqlite.get('SELECT trigger FROM bot_messages WHERE id = ?', 'b1').trigger, 'imported');
  assert.equal(world.llm.calls.length, 0);
  assert.deepEqual(sent(world), []);
});

test('a failing catch-up fetch is a warning; state restore and the intervals still happen', async (t) => {
  const world = await newWorld(t, { preload: previousRun({ humans: [human('m1', BASE_TIME - 5 * HOUR)] }) });
  world.discord.channel.messages.failNext(new Error('discord 503'), { times: 1 });
  await world.ready();
  assert.match(world.logs.warn.map((args) => args.join(' ')).join('\n'), /catch up.*failed/s);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});

test('more than the cap is imported oldest first, warns, and restarts activity fresh', async (t) => {
  const world = await newWorld(t, {
    config: { catchUp: { maxMessages: 2 } },
    preload: previousRun({ humans: [human('m1', BASE_TIME - 5 * HOUR)] }),
  });
  seedChannel(world, [
    { id: 'm1', author: 'alice', content: HELLO, timestamp: BASE_TIME - 5 * HOUR },
    { id: 'm2', author: 'bob', content: 'did you see that', timestamp: BASE_TIME - 4 * HOUR },
    { id: 'm3', author: 'bob', content: 'what a night it was', timestamp: BASE_TIME - 3 * HOUR },
    { id: 'm4', author: 'carol', content: 'a later message here', timestamp: BASE_TIME - 2 * HOUR },
  ]);
  await world.ready();
  assert.deepEqual(world.sqlite.all('SELECT id FROM messages ORDER BY timestamp').map((r) => r.id), ['m1', 'm2', 'm3']);
  assert.match(world.logs.warn.map((args) => args.join(' ')).join('\n'), /npm run backfill/);
  await world.advance(48 * HOUR);
  assert.deepEqual(sent(world), [], 'the bot counts as the last speaker after a capped catch-up');
});

test('ClientReady emitted twice runs one catch-up and one set of intervals', async (t) => {
  const world = await newWorld(t, { preload: previousRun({ humans: [human('m1', BASE_TIME - 5 * HOUR)] }) });
  seedChannel(world, [{ id: 'm1', author: 'alice', content: HELLO, timestamp: BASE_TIME - 5 * HOUR }]);
  await world.ready();
  await world.ready();
  assert.equal(world.discord.channel.messages.calls.filter((call) => call.after !== undefined).length, 1);
  await world.advance(10 * MINUTE);
  assert.equal(sent(world).length, 1);
});
