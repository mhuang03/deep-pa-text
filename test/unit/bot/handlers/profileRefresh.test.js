import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfileRefresh } from '../../../../src/bot/handlers/profileRefresh.js';
import { loadConfig } from '../../../../src/config.js';

const setup = ({ channel = { guild: { id: 'g1' } }, failRefresh = null } = {}) => {
  const calls = [];
  const logs = { info: [], error: [] };
  const client = {
    channels: { fetch: async (id) => (calls.push(['channel', id]), channel) },
    guilds: { fetch: async (id) => (calls.push(['guild', id]), { id }) },
  };
  const memberProfiles = {
    refreshAll: async (guild) => {
      calls.push(['refresh', guild.id]);
      if (failRefresh) throw failRefresh;
      return { checked: 4, changed: 1, failed: 2 };
    },
  };
  const run = createProfileRefresh({
    client, config: loadConfig({}), memberProfiles,
    logger: { info: (m) => logs.info.push(m), error: (...a) => logs.error.push(a) },
  });
  return { run, calls, logs };
};

test('refreshes the guild of the configured channel and logs the counts', async () => {
  const { run, calls, logs } = setup();
  await run();
  assert.deepEqual(calls, [['channel', '704837777564500149'], ['refresh', 'g1']]);
  assert.match(logs.info[0], /4 checked, 1 changed, 2 failed/);
});

test('fetches the guild when the channel does not carry it', async () => {
  const { run, calls } = setup({ channel: { guildId: 'g2' } });
  await run();
  assert.deepEqual(calls.slice(1), [['guild', 'g2'], ['refresh', 'g2']]);
});

test('catches and logs any error', async () => {
  const { run, logs } = setup({ failRefresh: new Error('boom') });
  await run();
  assert.equal(logs.error.length, 1);
  assert.equal(logs.error[0][1].message, 'boom');
});

test('catches a channel lookup failure', async () => {
  const { run, logs } = setup({ channel: null });
  await run();
  assert.equal(logs.error.length, 1);
});
