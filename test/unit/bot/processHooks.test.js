import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installProcessHooks } from '../../../src/bot/processHooks.js';

const setup = ({ shuttingDown = false } = {}) => {
  const fake = new EventEmitter();
  const exits = [];
  fake.exit = (code) => exits.push(code);
  const shutdowns = [];
  const logs = [];
  installProcessHooks({
    process: fake,
    lifecycle: { shutdown: async (o) => shutdowns.push(o), isShuttingDown: () => shuttingDown },
    logger: { error: (...a) => logs.push(a) },
  });
  return { fake, exits, shutdowns, logs };
};

test('SIGINT and SIGTERM shut down gracefully with code 0', () => {
  const { fake, shutdowns } = setup();
  fake.emit('SIGINT');
  fake.emit('SIGTERM');
  assert.deepEqual(shutdowns, [{ reason: 'SIGINT', code: 0 }, { reason: 'SIGTERM', code: 0 }]);
});

test('a second signal during shutdown exits immediately with code 1', () => {
  const { fake, exits, shutdowns } = setup({ shuttingDown: true });
  fake.emit('SIGTERM');
  assert.deepEqual(exits, [1]);
  assert.deepEqual(shutdowns, []);
});

test('an unhandled rejection or uncaught exception is logged and shuts down at once with code 1', () => {
  const { fake, shutdowns, logs } = setup();
  fake.emit('unhandledRejection', new Error('a'));
  fake.emit('uncaughtException', new Error('b'));
  assert.equal(logs.length, 2);
  assert.deepEqual(shutdowns.map(({ code, graceMs }) => [code, graceMs]), [[1, 0], [1, 0]]);
});
