import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';

const HELLO = 'hello there friends';
const HOUR = 3_600_000;
const MINUTE = 60_000;
const CHECK_GAP_MS = 11_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const RATE_LIMIT_GAP_MS = 6 * MINUTE;
const SETTLE_TURNS = 20;

const newWorld = async (t, options = { random: 0 }) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const profileRows = (world, username = 'bob') =>
  world.sqlite.all('SELECT * FROM user_profiles WHERE username = ? ORDER BY observed_at', username);
const icon = (message) => message.replies.at(-1).embeds.at(-1).data.author.icon_url;
const lookups = (world) => world.discord.guild.members.calls;
const turn = () => new Promise((resolve) => setImmediate(resolve));

// A send waits on a mock timer, so it cannot be driven through emitMessage: let it reach the timer first.
const sendWhileHanging = async (world) => {
  const message = world.addHistory({ content: HELLO });
  world.discord.client.emit('messageCreate', message);
  for (let i = 0; i < SETTLE_TURNS; i += 1) await turn();
  await world.advance(LOOKUP_TIMEOUT_MS);
  return message;
};

test('the first send as a user records a profile and uses the live avatar', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(icon(message), 'https://cdn.example/avatars/bob.png');
  const rows = profileRows(world);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].user_id, rows[0].display_name], ['user-bob', 'bob-display']);
});

test('a changed nickname and avatar are used at the next send and recorded as a second row', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ content: HELLO });
  world.discord.guild.members.update('bob', { displayName: 'Bobbo', avatarURL: 'https://cdn.example/new.png' });
  await world.advance(RATE_LIMIT_GAP_MS);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(icon(message), 'https://cdn.example/new.png');
  const rows = profileRows(world);
  assert.deepEqual(rows.map((r) => r.display_name), ['bob-display', 'Bobbo']);
});

test('nothing changed means no new row', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ content: HELLO });
  await world.advance(RATE_LIMIT_GAP_MS);
  await world.emitMessage({ content: HELLO });
  assert.equal(profileRows(world).length, 1);
  assert.equal(lookups(world).length, 2);
});

test('a failing lookup uses the stored profile and the message is still sent', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ content: HELLO });
  world.discord.guild.members.setFailing(true);
  await world.advance(RATE_LIMIT_GAP_MS);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(icon(message), 'https://cdn.example/avatars/bob.png');
  assert.equal(world.logs.warn.length, 1);
  assert.equal(profileRows(world).length, 1);
});

test('a hanging lookup gives up after lookupTimeoutMs, warns once and still sends', async (t) => {
  const world = await newWorld(t);
  world.discord.guild.members.setHanging(true);
  const message = await sendWhileHanging(world);
  assert.equal(message.replies.length, 1);
  assert.equal(world.logs.warn.length, 1);
  assert.equal(message.replies[0].embeds.at(-1).data.author.name, 'bob');
  assert.ok(!icon(message));
});

test('without a stored profile a failure means the username and no avatar', async (t) => {
  const world = await newWorld(t);
  world.discord.guild.members.setFailing(true);
  const message = await world.emitMessage({ content: HELLO });
  assert.ok(!icon(message));
  assert.deepEqual(profileRows(world), []);
});

test('a member whose username merely starts with bob, or whose nickname is bob, is never used for bob', async (t) => {
  const world = await newWorld(t);
  const { members } = world.discord.guild;
  members.remove('bob');
  members.add({ username: 'bobby', avatarURL: 'https://cdn.example/bobby.png' });
  members.add({ username: 'zed', displayName: 'bob', avatarURL: 'https://cdn.example/zed.png' });
  const message = await world.emitMessage({ content: HELLO });
  assert.ok(!icon(message));
  assert.deepEqual(profileRows(world), []);
});

test('once the id is known the lookup is by id, so a username change on Discord still resolves', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ content: HELLO });
  world.discord.guild.members.update('bob', { username: 'robert', displayName: 'Robert' });
  await world.advance(RATE_LIMIT_GAP_MS);
  const message = await world.emitMessage({ content: HELLO });
  assert.deepEqual(lookups(world).map((c) => c.method), ['search', 'fetch']);
  assert.equal(lookups(world)[1].args.force, true);
  assert.equal(icon(message), 'https://cdn.example/avatars/bob.png');
  assert.deepEqual(profileRows(world).map((r) => r.display_name), ['bob-display', 'Robert']);
});

test('an id from users.json makes the very first lookup exact', async (t) => {
  const users = [{ username: 'alice', name: 'A' }, { username: 'bob', name: 'B', id: 'bob-id' }];
  const world = await newWorld(t, { random: 0, users });
  assert.equal(lookups(world).length, 0);
  await world.emitMessage({ content: HELLO });
  assert.deepEqual(lookups(world), [{ method: 'fetch', args: { user: 'bob-id', force: true } }]);
});

test('a member who left the server falls back to the stored profile', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ content: HELLO });
  world.discord.guild.members.remove('bob');
  await world.advance(RATE_LIMIT_GAP_MS);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(icon(message), 'https://cdn.example/avatars/bob.png');
  assert.equal(world.errors.length, 0);
});

test('the parts of a burst share one member lookup', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('one\n<split>\ntwo\n<split>\nthree');
  await world.emitMessage({ content: HELLO });
  assert.equal(world.discord.channel.sent.length, 2);
  assert.equal(lookups(world).length, 1);
});

test('two sends as the same user in quick succession share one lookup', async (t) => {
  const world = await newWorld(t);
  const target = { content: 'a replyable message' };
  const first = await world.openReplyCommand({ target, user: 'alice' });
  const second = await world.openReplyCommand({ target, user: 'dave' });
  await Promise.all([first.submit({ author: 'bob' }), second.submit({ author: 'bob' })]);
  assert.equal(lookups(world).length, 1);
});

test('a send after the minimum interval looks the user up again', async (t) => {
  const world = await newWorld(t);
  const target = { content: 'a replyable message' };
  await (await world.openReplyCommand({ target, user: 'alice' })).submit({ author: 'bob' });
  await world.advance(CHECK_GAP_MS);
  await (await world.openReplyCommand({ target, user: 'dave' })).submit({ author: 'bob' });
  assert.equal(lookups(world).length, 2);
});

test('the hourly refresh checks every directory user and records changes', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  assert.equal(lookups(world).length, 4);
  world.discord.guild.members.update('carol', { displayName: 'Caz' });
  await world.advance(HOUR);
  assert.equal(lookups(world).length, 8);
  assert.deepEqual(profileRows(world, 'carol').map((r) => r.display_name), ['carol-display', 'Caz']);
  assert.equal(profileRows(world, 'bob').length, 1);
  assert.ok(world.logs.log.some((args) => /4 checked, 1 changed, 0 failed/.test(args.join(' '))));
});

test('a failing refresh is counted, logged and does not throw', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  world.discord.guild.members.setFailing(true);
  await world.advance(HOUR);
  assert.ok(world.logs.log.some((args) => /4 checked, 0 changed, 4 failed/.test(args.join(' '))));
  assert.deepEqual(world.errors, []);
});

test('the refresh at ready does not delay ready', async (t) => {
  const world = await newWorld(t);
  world.discord.guild.members.setHanging(true);
  await world.ready();
  assert.equal(lookups(world).length, 1);
  assert.deepEqual(world.errors, []);
});
