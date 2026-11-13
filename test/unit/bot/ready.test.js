import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReady } from '../../../src/bot/ready.js';
import { loadConfig } from '../../../src/config.js';

const setup = ({ config = loadConfig({}), restoreError = null, catchUpResult = { capped: false }, catchUpError = null } = {}) => {
  const events = [];
  const logs = { info: [], warn: [], error: [] };
  const lifecycle = {
    track: (fn, name) => async (...args) => { events.push(['run', name]); return fn(...args); },
    every: (fn, ms) => events.push(['every', ms]),
  };
  const deps = {
    client: { user: { tag: 'bot#1' }, channels: { fetch: async (id) => ({ id }) } },
    config,
    handlers: { reviveTick: async () => {}, profileRefresh: async () => {} },
    lifecycle,
    startupTasks: {
      restoreState: async (arg) => { events.push(['restore', arg]); if (restoreError) throw restoreError; },
      catchUp: async (channel) => { events.push(['catchUp', channel.id]); if (catchUpError) throw catchUpError; return catchUpResult; },
    },
    vectorHealth: {
      repair: async () => {}, startupRepair: async () => events.push('startupRepair'),
      noteFailure: (error) => events.push(['noteFailure', error.message]),
    },
    logger: { info: (m) => logs.info.push(m), warn: (...a) => logs.warn.push(a), error: (...a) => logs.error.push(a) },
  };
  return { ready: createReady(deps), deps, events, logs, config };
};

const names = (events) => events.map((e) => (Array.isArray(e) ? e.join(':') : e));

test('restores state, starts the timers, catches up, restores again and starts the repair', async () => {
  const { ready, events, logs, config } = setup();
  await ready.onReady();
  assert.deepEqual(logs.info, ['Logged in as bot#1']);
  const every = events.filter((e) => e[0] === 'every').map((e) => e[1]);
  assert.deepEqual(every, [config.revive.checkIntervalMs, config.profiles.refreshIntervalMs, config.vector.repairIntervalMs]);
  const order = names(events).filter((e) => /^(restore|catchUp|startupRepair)/.test(e));
  assert.deepEqual(order, ['restore:', `catchUp:${config.discord.channelId}`, 'restore:[object Object]', 'startupRepair']);
});

test('onReady runs once', async () => {
  const { ready, events } = setup();
  await ready.onReady();
  const first = events.length;
  await ready.onReady();
  assert.equal(events.length, first + 1);
});

test('the override period is used when revive override is on, and no profile timer when refresh is off', async () => {
  const config = loadConfig({});
  const custom = { ...config, revive: { ...config.revive, override: true }, profiles: { ...config.profiles, refreshIntervalMs: 0 } };
  const { ready, events } = setup({ config: custom });
  await ready.onReady();
  const every = events.filter((e) => e[0] === 'every').map((e) => e[1]);
  assert.deepEqual(every, [custom.revive.overrideCheckIntervalMs, custom.vector.repairIntervalMs]);
});

test('a failed catch-up is logged as a warning and noted as vector debt', async () => {
  const { ready, events, logs } = setup({ catchUpError: new Error('gateway down') });
  await ready.onReady();
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0][0], /catch up/);
  assert.ok(names(events).includes('noteFailure:catch-up failed'));
  assert.equal(events.filter((e) => e[0] === 'restore').length, 1);
});

test('a failed first restore is logged and the startup continues', async () => {
  const { ready, events, logs } = setup({ restoreError: new Error('db') });
  await ready.onReady();
  assert.equal(logs.error.length >= 1, true);
  assert.ok(names(events).some((e) => e.startsWith('catchUp')));
});

const readyWithBank = (status) => {
  const logs = { warn: [] };
  const base = setup();
  const ready = createReady({
    ...base.deps, topicSource: { bankStatus: () => status }, logger: { ...base.deps.logger, warn: (...a) => logs.warn.push(a) },
  });
  return { ready, logs };
};

test('logs one line saying to run npm run topics when the topic bank is empty or stale', async () => {
  for (const status of [{ topics: 0, completedAt: null, stale: true }, { topics: 5, completedAt: 1, stale: true }]) {
    const { ready, logs } = readyWithBank(status);
    await ready.onReady();
    assert.equal(logs.warn.length, 1);
    assert.match(logs.warn[0][0], /npm run topics/);
  }
});

test('says nothing about the topic bank when it is filled and fresh', async () => {
  const { ready, logs } = readyWithBank({ topics: 5, completedAt: 1, stale: false });
  await ready.onReady();
  assert.deepEqual(logs.warn, []);
});

test('a failing bank check is logged and the startup continues', async () => {
  const base = setup();
  const errors = [];
  const ready = createReady({
    ...base.deps, topicSource: { bankStatus: () => { throw new Error('db'); } },
    logger: { ...base.deps.logger, warn: (...a) => errors.push(a) },
  });
  await ready.onReady();
  assert.match(errors[0][0], /topic bank status/);
  assert.ok(base.events.some((e) => e === 'startupRepair'));
});
