import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberProfiles } from '../../../src/profiles/memberProfiles.js';
import { createProfileStore } from '../../../src/storage/profileStore.js';
import { openDatabase } from '../../../src/storage/database.js';
import { buildUserDirectory } from '../../../src/userData/loadData.js';
import { loadConfig } from '../../../src/config.js';

const LIVE = { userId: 'u-bob', displayName: 'Bobbo', avatarURL: 'https://a/bob.png' };
const MIN = 10000;

const setup = ({ users = [{ username: 'bob', name: 'Bob' }], overrides = {} } = {}) => {
  const state = { now: 1000, timers: [], lookups: [], live: new Map([['bob', LIVE]]), fail: new Map(), hang: false };
  const logs = { info: [], warn: [] };
  const profileStore = createProfileStore({ db: openDatabase(':memory:') });
  const fetchMember = async (guild, args) => {
    state.lookups.push(args);
    if (state.hang) await new Promise(() => {});
    if (state.fail.has(args.username)) throw state.fail.get(args.username);
    return state.live.get(args.username) ?? null;
  };
  const clock = {
    now: () => state.now,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      state.timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  };
  const config = loadConfig({});
  const profiles = createMemberProfiles({
    profileStore, fetchMember, userDirectory: buildUserDirectory(users),
    config: { ...config, profiles: { ...config.profiles, ...overrides } }, clock,
    logger: { info: (m) => logs.info.push(m), warn: (...a) => logs.warn.push(a) },
  });
  return { profiles, state, logs, profileStore };
};

const GUILD = { id: 'g' };

test('first check records the live profile and returns it', async () => {
  const { profiles, profileStore, logs } = setup();
  assert.deepEqual(await profiles.current('bob', GUILD), { username: 'bob', ...LIVE });
  assert.deepEqual(profileStore.latest('bob'), { username: 'bob', ...LIVE });
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /bob.*userId, displayName, avatarURL/);
  assert.ok(!logs.info[0].includes('Bobbo'));
});

test('no change records nothing and logs nothing', async () => {
  const { profiles, state, profileStore, logs } = setup();
  await profiles.current('bob', GUILD);
  state.now += MIN;
  await profiles.current('bob', GUILD);
  assert.equal(state.lookups.length, 2);
  assert.deepEqual(profileStore.namesOf('bob'), ['Bobbo']);
  assert.equal(logs.info.length, 1);
});

for (const [field, value] of [['userId', 'u-new'], ['displayName', 'Renamed'], ['avatarURL', 'https://a/new.png']]) {
  test(`a changed ${field} records a new row and keeps the old one`, async () => {
    const { profiles, state, profileStore, logs } = setup();
    await profiles.current('bob', GUILD);
    state.now += MIN;
    state.live.set('bob', { ...LIVE, [field]: value });
    const result = await profiles.current('bob', GUILD);
    assert.equal(result[field], value);
    assert.equal(profileStore.latest('bob')[field], value);
    assert.equal(profileStore.all().length, 1);
    assert.match(logs.info.at(-1), new RegExp(field));
  });
}

test('a lookup within the minimum interval is served from the cache; at the interval it is repeated', async () => {
  const { profiles, state } = setup();
  await profiles.current('bob', GUILD);
  state.now += MIN - 1;
  await profiles.current('bob', GUILD);
  assert.equal(state.lookups.length, 1);
  state.now += 1;
  await profiles.current('bob', GUILD);
  assert.equal(state.lookups.length, 2);
});

test('concurrent calls share one lookup', async () => {
  const { profiles, state } = setup();
  const results = await Promise.all([profiles.current('bob', GUILD), profiles.current('bob', GUILD), profiles.current('bob', GUILD)]);
  assert.equal(state.lookups.length, 1);
  assert.equal(results[0], results[1]);
});

test('the lookup is by stored id, else directory id, else by search', async () => {
  const withId = setup({ users: [{ username: 'bob', name: 'Bob', id: 'dir-id' }] });
  await withId.profiles.current('bob', GUILD);
  assert.equal(withId.state.lookups[0].userId, 'dir-id');
  assert.equal(withId.state.lookups[0].searchLimit, 100);
  const plain = setup();
  await plain.profiles.current('bob', GUILD);
  assert.equal(plain.state.lookups[0].userId, undefined);
  plain.state.now += MIN;
  await plain.profiles.current('bob', GUILD);
  assert.equal(plain.state.lookups[1].userId, 'u-bob');
});

test('a stored id wins over the directory id', async () => {
  const { profiles, state, profileStore } = setup({ users: [{ username: 'bob', name: 'Bob', id: 'dir-id' }] });
  profileStore.record({ username: 'bob', userId: 'stored-id', displayName: 'S', avatarURL: null, observedAt: 1 });
  await profiles.current('bob', GUILD);
  assert.equal(state.lookups[0].userId, 'stored-id');
});

test('a failing lookup returns the stored profile, warns once and records nothing', async () => {
  const { profiles, state, logs, profileStore } = setup();
  await profiles.current('bob', GUILD);
  state.fail.set('bob', new Error('rest down'));
  state.now += MIN;
  assert.deepEqual(await profiles.current('bob', GUILD), { username: 'bob', ...LIVE });
  state.now += MIN;
  await profiles.current('bob', GUILD);
  assert.equal(logs.warn.length, 1);
  assert.deepEqual(profileStore.namesOf('bob'), ['Bobbo']);
  assert.equal(state.lookups.length, 3);
});

test('failures are not cached, so the next call looks again', async () => {
  const { profiles, state } = setup();
  state.fail.set('bob', new Error('rest down'));
  await profiles.current('bob', GUILD);
  state.fail.clear();
  assert.equal((await profiles.current('bob', GUILD)).displayName, 'Bobbo');
});

test('the warning repeats after the refresh interval', async () => {
  const { profiles, state, logs } = setup();
  state.fail.set('bob', new Error('rest down'));
  await profiles.current('bob', GUILD);
  state.now += 3600000;
  await profiles.current('bob', GUILD);
  assert.equal(logs.warn.length, 2);
});

test('with nothing stored a failure yields the username and no avatar', async () => {
  const { profiles, state } = setup();
  state.fail.set('bob', new Error('rest down'));
  assert.deepEqual(await profiles.current('bob', GUILD), {
    username: 'bob', userId: null, displayName: 'bob', avatarURL: null,
  });
});

test('a member that is not found keeps the stored profile', async () => {
  const { profiles, state, logs } = setup();
  await profiles.current('bob', GUILD);
  state.live.delete('bob');
  state.now += MIN;
  assert.equal((await profiles.current('bob', GUILD)).displayName, 'Bobbo');
  assert.equal(logs.warn.length, 1);
});

test('a hanging lookup times out after lookupTimeoutMs and falls back', async () => {
  const { profiles, state, logs } = setup();
  state.hang = true;
  const pending = profiles.current('bob', GUILD);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, 5000);
  state.timers[0].fn();
  assert.equal((await pending).displayName, 'bob');
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0][1].message, /timed out after 5000 ms/);
});

test('refreshAll checks every directory user in turn, ignoring the minimum interval', async () => {
  const users = [{ username: 'bob', name: 'B' }, { username: 'carol', name: 'C' }, { username: 'dave', name: 'D' }];
  const { profiles, state } = setup({ users });
  state.live.set('carol', { ...LIVE, userId: 'u-carol', displayName: 'Carol' });
  state.live.set('dave', { ...LIVE, userId: 'u-dave', displayName: 'Dave' });
  assert.deepEqual(await profiles.refreshAll(GUILD), { checked: 3, changed: 3, failed: 0 });
  assert.deepEqual(await profiles.refreshAll(GUILD), { checked: 3, changed: 0, failed: 0 });
  assert.equal(state.lookups.length, 6);
});

test('refreshAll counts a failure and still checks the rest', async () => {
  const users = [{ username: 'bob', name: 'B' }, { username: 'carol', name: 'C' }];
  const { profiles, state } = setup({ users });
  state.live.set('carol', { ...LIVE, userId: 'u-carol' });
  state.fail.set('bob', new Error('boom'));
  assert.deepEqual(await profiles.refreshAll(GUILD), { checked: 2, changed: 1, failed: 1 });
});

test('refreshAll refreshes a user whose recent check is still cached', async () => {
  const { profiles, state } = setup();
  await profiles.current('bob', GUILD);
  state.live.set('bob', { ...LIVE, displayName: 'Renamed' });
  assert.deepEqual(await profiles.refreshAll(GUILD), { checked: 1, changed: 1, failed: 0 });
  assert.equal((await profiles.current('bob', GUILD)).displayName, 'Renamed');
});

test('a minimum interval of 0 never serves from the cache', async () => {
  const { profiles, state } = setup({ overrides: { minCheckIntervalMs: 0 } });
  await profiles.current('bob', GUILD);
  await profiles.current('bob', GUILD);
  assert.equal(state.lookups.length, 2);
});
