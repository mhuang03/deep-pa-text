import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUserDirectory, loadData } from '../../../src/userData/loadData.js';
import { PING_CACHE, USERS } from '../../support/fixtures.js';

test('loadData reads and parses both files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usersPath = path.join(dir, 'users.json');
  const pingCachePath = path.join(dir, 'pings.json');
  fs.writeFileSync(usersPath, JSON.stringify(USERS));
  fs.writeFileSync(pingCachePath, JSON.stringify(PING_CACHE));
  assert.deepEqual(loadData({ usersPath, pingCachePath }), { users: USERS, pingCache: PING_CACHE });
});

test('loadData throws on a missing file', () => {
  assert.throws(() => loadData({ usersPath: '/nonexistent/u.json', pingCachePath: '/nonexistent/p.json' }));
});

test('buildUserDirectory exposes users, usernames and nameOf', () => {
  const directory = buildUserDirectory(USERS);
  assert.equal(directory.users, USERS);
  assert.deepEqual([...directory.usernames], ['alice', 'bob', 'carol', 'dave']);
  assert.equal(directory.nameOf('bob'), 'Bob Example');
});

test('nameOf yields undefined for unknown usernames', () => {
  const directory = buildUserDirectory(USERS);
  assert.equal(directory.nameOf('mallory'), undefined);
  assert.equal(directory.nameOf('constructor'), undefined);
});
