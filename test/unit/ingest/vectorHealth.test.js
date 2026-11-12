import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorHealth } from '../../../src/ingest/vectorHealth.js';

const config = { vector: { repairIntervalMs: 600000, repairWindowMs: 1000000 } };
const TOTALS = { checked: 3, addedMessages: 2, addedReplies: 1, filledMetadata: 0, skipped: 0 };

const setup = ({ runs = [] } = {}) => {
  let time = 5000000;
  const calls = [];
  const logs = { info: [], warn: [] };
  const queue = [...runs];
  const vectorSync = {
    run: async (options) => {
      calls.push(options);
      const next = queue.shift() ?? TOTALS;
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next();
      return next;
    },
  };
  const clock = { now: () => time };
  const logger = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) };
  const health = createVectorHealth({ vectorSync, clock, config, logger });
  return { health, calls, logs, advance: (ms) => { time += ms; } };
};

test('repair without debt makes no sync call', async () => {
  const { health, calls } = setup();
  await health.repair();
  assert.deepEqual(calls, []);
});

test('noteFailure puts the store in debt and repair syncs the window then clears the debt', async () => {
  const { health, calls, logs } = setup();
  health.noteFailure(new Error('chroma down'));
  await health.repair();
  assert.deepEqual(calls, [{ sinceMs: 4000000, quiet: true }]);
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /checked 3 rows.*added 2 messages and 1 replies/);
  await health.repair();
  assert.equal(calls.length, 1);
});

test('noteFailure logs one warning per repair interval', () => {
  const { health, logs, advance } = setup();
  health.noteFailure(new Error('a'));
  health.noteFailure(new Error('b'));
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /missing.*repaired automatically/);
  advance(600000);
  health.noteFailure(new Error('c'));
  assert.equal(logs.warn.length, 2);
});

test('a failed repair keeps the debt, warns and never throws; the next tick retries', async () => {
  const { health, calls, logs } = setup({ runs: [new Error('still down')] });
  health.noteFailure(new Error('x'));
  await health.repair();
  assert.match(logs.warn.at(-1), /Vector repair failed.*still down/);
  await health.repair();
  assert.equal(calls.length, 2);
  await health.repair();
  assert.equal(calls.length, 2);
});

test('a failure noted while a repair runs keeps the debt', async () => {
  let health;
  const setupRun = setup({ runs: [() => {
    health.noteFailure(new Error('new failure'));
    return TOTALS;
  }] });
  health = setupRun.health;
  health.noteFailure(new Error('first'));
  await health.repair();
  await health.repair();
  assert.equal(setupRun.calls.length, 2);
});

test('only one sync runs at a time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { health, calls } = setup({ runs: [async () => { await gate; return TOTALS; }] });
  health.noteFailure(new Error('x'));
  const first = health.repair();
  await health.repair();
  await health.startupRepair();
  assert.equal(calls.length, 1);
  release();
  await first;
});

test('startupRepair syncs the window once regardless of debt', async () => {
  const { health, calls } = setup();
  await health.startupRepair();
  assert.deepEqual(calls, [{ sinceMs: 4000000, quiet: true }]);
});

test('a failed startupRepair notes a failure so the interval retries it', async () => {
  const { health, calls, logs } = setup({ runs: [new Error('down')] });
  await health.startupRepair();
  assert.ok(logs.warn.length >= 1);
  await health.repair();
  assert.equal(calls.length, 2);
});
