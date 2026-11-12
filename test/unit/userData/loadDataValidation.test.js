import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../../../src/userData/loadData.js';
import { isConfigError } from '../../../src/config/errors.js';
import { PING_CACHE, USERS } from '../../support/fixtures.js';

const PATHS = { usersPath: 'data/users.json', pingCachePath: 'data/ping_caches.json' };

const load = (users, pings = PING_CACHE) => loadData(PATHS, {
  readFileSync: (file) => {
    const value = file === PATHS.usersPath ? users : pings;
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? value : JSON.stringify(value);
  },
});

const configError = (fn, fragment) => assert.throws(fn, (e) => isConfigError(e) && e.message.includes(fragment), fragment);

test('reads and returns both files', () => {
  assert.deepEqual(load(USERS), { users: USERS, pingCache: PING_CACHE });
});

test('a missing or unreadable file names the file', () => {
  configError(() => load(new Error('ENOENT')), 'data/users.json');
  configError(() => load(USERS, new Error('ENOENT')), 'data/ping_caches.json');
});

test('invalid JSON names the file', () => {
  configError(() => load('{nope'), 'data/users.json');
  configError(() => load(USERS, '[1,'), 'data/ping_caches.json');
});

test('users.json must be a non-empty array of objects', () => {
  configError(() => load([]), 'data/users.json');
  configError(() => load({ a: 1 }), 'data/users.json');
  configError(() => load([null]), 'data/users.json');
  configError(() => load(['bob']), 'data/users.json');
});

test('each user needs a non-empty string username and name', () => {
  configError(() => load([{ username: 'bob' }]), 'name');
  configError(() => load([{ username: 'bob', name: ' ' }]), 'name');
  configError(() => load([{ name: 'Bob' }]), 'username');
  configError(() => load([{ username: 5, name: 'Bob' }]), 'username');
});

test('an id must be 5 to 25 digits and may be a number, which is stored as a string', () => {
  configError(() => load([{ username: 'bob', name: 'Bob', id: 'abc' }]), 'id');
  configError(() => load([{ username: 'bob', name: 'Bob', id: '1234' }]), 'id');
  configError(() => load([{ username: 'bob', name: 'Bob', id: {} }]), 'id');
  const { users } = load([{ username: 'bob', name: 'Bob', id: 123456, extra: true }, { username: 'al', name: 'Al', id: null }]);
  assert.equal(users[0].id, '123456');
  assert.equal(users[0].extra, true);
});

test('usernames must be unique ignoring case', () => {
  configError(() => load([{ username: 'Bob', name: 'A' }, { username: 'bob', name: 'B' }]), 'duplicate');
});

test('ping caches default missing sections to empty objects', () => {
  assert.deepEqual(load(USERS, {}).pingCache, { users: {}, roles: {}, channels: {} });
  assert.deepEqual(load(USERS, { users: { 1: 'a' } }).pingCache, { users: { 1: 'a' }, roles: {}, channels: {} });
});

test('ping caches must be objects, including their sections', () => {
  configError(() => load(USERS, 'null'), 'data/ping_caches.json');
  configError(() => load(USERS, '[]'), 'data/ping_caches.json');
  configError(() => load(USERS, { roles: [] }), 'roles');
  configError(() => load(USERS, { channels: 'x' }), 'channels');
  configError(() => load(USERS, { users: null, roles: {} }), 'data/ping_caches.json');
});
