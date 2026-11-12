import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUsers, validatePingCache } from '../../../src/userData/validate.js';
import { isConfigError } from '../../../src/config/errors.js';

const FILE = 'users.json';

test('accepts users and normalises a numeric id to a string', () => {
  const users = validateUsers([{ username: 'alice', name: 'Alice', id: 12345678 }, { username: 'bob', name: 'Bob' }], FILE);
  assert.deepEqual(users, [{ username: 'alice', name: 'Alice', id: '12345678' }, { username: 'bob', name: 'Bob' }]);
});

test('rejects an empty or non-array users file', () => {
  [[], {}, null, 'x'].forEach((raw) => assert.throws(() => validateUsers(raw, FILE), /non-empty array/));
});

test('names the entry and field that is wrong', () => {
  assert.throws(() => validateUsers(['x'], FILE), /users\.json: entry 1 must be an object/);
  assert.throws(() => validateUsers([{ name: 'A' }], FILE), /entry 1 needs a non-empty string "username"/);
  assert.throws(() => validateUsers([{ username: 'a', name: ' ' }], FILE), /\(a\) needs a non-empty string "name"/);
  assert.throws(() => validateUsers([{ username: 'a', name: 'A', id: 'abc' }], FILE), /invalid "id"/);
});

test('usernames are unique ignoring case', () => {
  assert.throws(
    () => validateUsers([{ username: 'Alice', name: 'A' }, { username: 'alice', name: 'B' }], FILE),
    (error) => isConfigError(error) && /duplicate username "alice"/.test(error.message),
  );
});

test('validatePingCache defaults the three sections to empty objects and keeps other keys', () => {
  assert.deepEqual(validatePingCache({ extra: 1 }, 'p.json'), { extra: 1, users: {}, roles: {}, channels: {} });
  assert.deepEqual(validatePingCache({ users: { a: 'b' } }, 'p.json').users, { a: 'b' });
});

test('validatePingCache rejects a non-object file or section', () => {
  assert.throws(() => validatePingCache([], 'p.json'), /p\.json must be an object/);
  assert.throws(() => validatePingCache({ roles: [] }, 'p.json'), /"roles" must be an object/);
});
