import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProfile } from '../../../src/profiles/memberProfileCheck.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});

const setup = ({ stored = null, live = undefined, lookupError = null } = {}) => {
  const recorded = [];
  const infos = [];
  const warnings = [];
  const lookups = [];
  let now = 1000;
  const ctx = {
    profileStore: { latest: () => stored, record: (row) => recorded.push(row) },
    fetchMember: async (guild, options) => { lookups.push(options); if (lookupError) throw lookupError; return live; },
    userDirectory: { idOf: (username) => (username === 'alice' ? '11111' : null) },
    config,
    clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => {} },
    logger: { info: (m) => infos.push(m), warn: (...a) => warnings.push(a) },
    warnedAt: new Map(),
  };
  return { ctx, recorded, infos, warnings, lookups, advance: (ms) => { now += ms; } };
};
const LIVE = { userId: '11111', displayName: 'Alice', avatarURL: 'http://a/1.png' };

test('a first sighting records every field and reports a change', async () => {
  const { ctx, recorded, infos } = setup({ live: LIVE });
  const result = await checkProfile(ctx, 'alice', { id: 'g' });
  assert.equal(result.status, 'changed');
  assert.deepEqual(result.profile, { username: 'alice', ...LIVE });
  assert.deepEqual(recorded, [{ username: 'alice', ...LIVE, observedAt: 1000 }]);
  assert.match(infos[0], /Profile of alice changed: userId, displayName, avatarURL/);
});

test('an unchanged profile records nothing', async () => {
  const { ctx, recorded } = setup({ live: LIVE, stored: { username: 'alice', ...LIVE } });
  assert.equal((await checkProfile(ctx, 'alice', {})).status, 'unchanged');
  assert.deepEqual(recorded, []);
});

test('only the fields that differ are named', async () => {
  const { ctx, infos } = setup({ live: { ...LIVE, displayName: 'New' }, stored: { username: 'alice', ...LIVE } });
  await checkProfile(ctx, 'alice', {});
  assert.match(infos[0], /changed: displayName$/);
});

test('looks the member up by the stored id, then the directory id, with the configured search limit', async () => {
  const stored = setup({ live: LIVE, stored: { username: 'alice', userId: '99999', displayName: 'A', avatarURL: null } });
  await checkProfile(stored.ctx, 'alice', {});
  assert.deepEqual(stored.lookups[0], { username: 'alice', userId: '99999', searchLimit: config.profiles.searchLimit });
  const fresh = setup({ live: LIVE });
  await checkProfile(fresh.ctx, 'alice', {});
  assert.equal(fresh.lookups[0].userId, '11111');
});

test('a missing member keeps the stored profile as a failed check', async () => {
  const stored = { username: 'alice', ...LIVE };
  const { ctx, warnings } = setup({ live: null, stored });
  const result = await checkProfile(ctx, 'alice', {});
  assert.equal(result.status, 'failed');
  assert.equal(result.profile, stored);
  assert.match(warnings[0][0], /Could not read the Discord profile of alice/);
});

test('without a stored profile a failed check falls back to the username', async () => {
  const { ctx } = setup({ lookupError: new Error('timeout') });
  const result = await checkProfile(ctx, 'bob', {});
  assert.deepEqual(result, { profile: { username: 'bob', userId: null, displayName: 'bob', avatarURL: null }, status: 'failed' });
});

test('a repeated failure is warned about once per refresh interval', async () => {
  const { ctx, warnings, advance } = setup({ lookupError: new Error('x') });
  await checkProfile(ctx, 'bob', {});
  await checkProfile(ctx, 'bob', {});
  assert.equal(warnings.length, 1);
  advance(config.profiles.refreshIntervalMs);
  await checkProfile(ctx, 'bob', {});
  assert.equal(warnings.length, 2);
});
