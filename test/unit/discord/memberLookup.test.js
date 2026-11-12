import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMember } from '../../../src/discord/memberLookup.js';
import { createMembers } from '../../support/fakes/members.js';

const setup = () => {
  const members = createMembers();
  members.add({ username: 'bob', displayName: 'Bobbo' });
  return { members, guild: { members } };
};

test('looks up by id with force and maps the member', async () => {
  const { members, guild } = setup();
  const result = await fetchMember(guild, { username: 'bob', userId: 'user-bob', searchLimit: 100 });
  assert.deepEqual(result, { userId: 'user-bob', displayName: 'Bobbo', avatarURL: 'https://cdn.example/avatars/bob.png' });
  assert.deepEqual(members.calls, [{ method: 'fetch', args: { user: 'user-bob', force: true } }]);
});

test('an unknown member or user code resolves to null', async () => {
  for (const code of [10007, 10013]) {
    const guild = { members: { fetch: async () => { throw Object.assign(new Error('gone'), { code }); } } };
    assert.equal(await fetchMember(guild, { username: 'bob', userId: 'x', searchLimit: 1 }), null, String(code));
  }
});

test('other lookup errors propagate', async () => {
  const boom = Object.assign(new Error('rate limited'), { code: 429 });
  const guild = { members: { fetch: async () => { throw boom; } } };
  await assert.rejects(fetchMember(guild, { username: 'bob', userId: 'x', searchLimit: 1 }), boom);
});

test('searches by username with the limit when there is no id', async () => {
  const { members, guild } = setup();
  const result = await fetchMember(guild, { username: 'bob', searchLimit: 7 });
  assert.equal(result.userId, 'user-bob');
  assert.deepEqual(members.calls, [{ method: 'search', args: { query: 'bob', limit: 7 } }]);
});

test('takes the exact username match, not the first prefix or nickname match', async () => {
  const { members, guild } = setup();
  members.add({ username: 'aaa', displayName: 'bob' });
  members.add({ username: 'bobby', displayName: 'Bobby' });
  members.remove('bob');
  members.add({ username: 'BOB', id: 'real', displayName: 'Real Bob' });
  const result = await fetchMember(guild, { username: 'bob', searchLimit: 100 });
  assert.equal(result.userId, 'real');
});

test('no exact match resolves to null', async () => {
  const { members, guild } = setup();
  members.remove('bob');
  members.add({ username: 'bobby' });
  members.add({ username: 'x', displayName: 'bob' });
  assert.equal(await fetchMember(guild, { username: 'bob', searchLimit: 100 }), null);
});

test('a missing avatar becomes null', async () => {
  const { members, guild } = setup();
  members.update('bob', { avatarURL: undefined });
  members.update('bob', { avatarURL: null });
  assert.equal((await fetchMember(guild, { username: 'bob', searchLimit: 5 })).avatarURL, null);
});
