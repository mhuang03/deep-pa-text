import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { createWorld } from '../support/world.js';
import { installProcessHooks } from '../../src/bot/processHooks.js';

const HELLO = 'hello there friends';
const errorText = (world) => world.logs.error.map((args) => args.join(' ')).join('\n');
const warnText = (world) => world.logs.warn.map((args) => args.join(' ')).join('\n');

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const withHooks = (world) => {
  const fakeProcess = new EventEmitter();
  fakeProcess.exit = (code) => world.exits.push(`hard ${code}`);
  installProcessHooks({ process: fakeProcess, lifecycle: world.container.lifecycle, logger: world.container.logger });
  return fakeProcess;
};

test('a disallowed-intents disconnect logs the hint, closes the client and database and exits 1', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitShardDisconnect(4014);
  await world.container.lifecycle.shutdown({ code: 1 });
  assert.match(errorText(world), /4014.*Message Content intent/);
  assert.equal(world.discord.destroyed, 1);
  assert.equal(world.databaseClosed, 1);
  assert.deepEqual(world.exits, [1]);
});

test('an authentication failure names the token variable', async (t) => {
  const world = await newWorld(t);
  await world.emitShardDisconnect(4004);
  assert.match(errorText(world), /DISCORD_BOT_TOKEN/);
  assert.deepEqual(world.exits, [1]);
});

test('other gateway events are only logged', async (t) => {
  const world = await newWorld(t);
  await world.emitGateway(Events.ShardError, new Error('socket reset'), 0);
  await world.emitGateway(Events.Warn, 'slow heartbeat');
  await world.emitGateway(Events.Error, new Error('client broke'));
  await world.emitGateway(Events.ShardReconnecting, 0);
  assert.match(errorText(world), /socket reset/);
  assert.match(errorText(world), /client broke/);
  assert.match(warnText(world), /slow heartbeat/);
  assert.deepEqual(world.exits, []);
});

test('SIGTERM while a reply is generated waits for it, sends it, records it, then exits 0', async (t) => {
  const world = await newWorld(t);
  const fakeProcess = withHooks(world);
  await world.ready();
  world.setRandom(0);
  const release = world.llm.hold();
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(message.replies.length, 0);
  world.sleepHook = async () => {
    release();
    await world.settle();
  };
  fakeProcess.emit('SIGTERM');
  await world.container.lifecycle.shutdown({ code: 0 });
  assert.equal(message.replies.length, 1);
  assert.equal(world.sqlite.all('SELECT * FROM bot_messages').length, 1);
  assert.equal(world.discord.destroyed, 1);
  assert.deepEqual(world.exits, [0]);
});

test('SIGTERM with a reply that never completes exits 0 after the grace period naming the handler', async (t) => {
  const world = await newWorld(t);
  const fakeProcess = withHooks(world);
  await world.ready();
  world.setRandom(0);
  world.llm.hold();
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  fakeProcess.emit('SIGTERM');
  await world.container.lifecycle.shutdown({ code: 0 });
  assert.deepEqual(world.exits, [0]);
  assert.match(warnText(world), /abandoning 1 handler.*messageCreate/);
  assert.equal(message.replies.length, 0);
  assert.equal(world.discord.destroyed, 1);
});

test('a message arriving after shutdown began is ignored', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  world.setRandom(0);
  await world.container.lifecycle.shutdown({ code: 0 });
  const message = await world.emitMessage({ author: 'alice', content: HELLO });
  assert.equal(message.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(world.sqlite.all('SELECT * FROM messages').length, 0);
});

test('two signals cause one graceful shutdown, and the second exits hard with code 1', async (t) => {
  const world = await newWorld(t);
  const fakeProcess = withHooks(world);
  fakeProcess.emit('SIGINT');
  fakeProcess.emit('SIGTERM');
  await world.container.lifecycle.shutdown({ code: 0 });
  assert.deepEqual(world.exits, ['hard 1', 0]);
  assert.equal(world.discord.destroyed, 1);
});

test('an unhandled rejection is logged and the process exits 1', async (t) => {
  const world = await newWorld(t);
  const fakeProcess = withHooks(world);
  fakeProcess.emit('unhandledRejection', new Error('lost promise'));
  await world.container.lifecycle.shutdown({ code: 0 });
  assert.match(errorText(world), /lost promise/);
  assert.deepEqual(world.exits, [1]);
});

test('a client.destroy failure is logged; the database is still closed and the exit still happens', async (t) => {
  const world = await newWorld(t);
  world.discord.client.destroy = async () => {
    throw new Error('destroy broke');
  };
  await world.container.lifecycle.shutdown({ code: 0 });
  assert.match(errorText(world), /destroy broke/);
  assert.equal(world.databaseClosed, 1);
  assert.deepEqual(world.exits, [0]);
});

test('shutdown stops the revive interval', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  await world.container.lifecycle.shutdown({ code: 0 });
  await world.advance(48 * 3_600_000);
  assert.deepEqual(world.discord.channel.sent, []);
});

test('an unfinished re-import stops startup before anything connects', async (t) => {
  await assert.rejects(
    createWorld({ preload: (container) => container.metaStore.setIfAbsent('reimport_started_at', '5') }),
    /npm run reimport -- --resume --yes/,
  );
  const world = await newWorld(t);
  assert.deepEqual(world.discord.loginTokens, ['test-discord-token']);
});

test('Chroma being down names the port and never logs in to Discord', async (t) => {
  let captured;
  await assert.rejects(
    createWorld({
      failHeartbeat: new Error('connection refused'),
      preload: (container) => { captured = container; },
    }),
    /Cannot reach Chroma on port 7429.*npx chroma run --port 7429/,
  );
  assert.ok(captured);
  const world = await newWorld(t);
  assert.equal(world.discord.loginTokens.length, 1);
});
