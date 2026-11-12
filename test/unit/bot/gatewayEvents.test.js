import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { registerGatewayEvents, CLOSE_HINTS } from '../../../src/bot/gatewayEvents.js';

const setup = () => {
  const client = new EventEmitter();
  const logs = [];
  const shutdowns = [];
  const logger = ['info', 'warn', 'error'].reduce(
    (acc, level) => ({ ...acc, [level]: (...args) => logs.push([level, ...args]) }), {},
  );
  registerGatewayEvents({ client, lifecycle: { shutdown: async (o) => shutdowns.push(o) }, logger });
  return { client, logs, shutdowns };
};

test('client errors and warnings are logged', () => {
  const { client, logs } = setup();
  client.emit(Events.Error, new Error('boom'));
  client.emit(Events.Warn, 'careful');
  assert.equal(logs[0][0], 'error');
  assert.equal(logs[1][0], 'warn');
  assert.match(logs[1][1], /careful/);
});

test('shard errors name the shard; reconnect and resume are informational', () => {
  const { client, logs, shutdowns } = setup();
  client.emit(Events.ShardError, new Error('ws'), 3);
  client.emit(Events.ShardReconnecting, 3);
  client.emit(Events.ShardResume, 3, 5);
  assert.deepEqual(logs.map(([level]) => level), ['error', 'info', 'info']);
  assert.match(logs[0][1], /shard 3/);
  assert.deepEqual(shutdowns, []);
});

test('every shard disconnect logs the code with a hint and shuts down with code 1', () => {
  const { client, logs, shutdowns } = setup();
  client.emit(Events.ShardDisconnect, { code: 4014 }, 0);
  client.emit(Events.ShardDisconnect, { code: 4004 }, 0);
  client.emit(Events.ShardDisconnect, { code: 4000 }, 0);
  assert.match(logs[0][1], /4014.*Message Content intent/);
  assert.match(logs[1][1], /DISCORD_BOT_TOKEN/);
  assert.match(logs[2][1], /4000/);
  assert.equal(logs.every(([level]) => level === 'error'), true);
  assert.deepEqual(shutdowns.map((s) => s.code), [1, 1, 1]);
  assert.ok(Object.keys(CLOSE_HINTS).length >= 6);
});

test('the invalidated event is not registered', () => {
  const { client } = setup();
  assert.equal(client.listenerCount(Events.Invalidated), 0);
});
