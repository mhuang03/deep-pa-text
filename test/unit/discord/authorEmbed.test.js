import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorEmbeds } from '../../../src/discord/authorEmbed.js';
import { loadConfig } from '../../../src/config.js';

const setup = (avatarURL = 'https://cdn.example/avatars/bob.png') => {
  const calls = [];
  const memberProfiles = {
    current: async (...args) => (calls.push(args), { username: 'bob', displayName: 'Bobbo', avatarURL }),
  };
  const embeds = createAuthorEmbeds({ config: loadConfig({}), memberProfiles });
  return { embeds, calls };
};

test('builds an author embed with the current profile avatar and brand colour', async () => {
  const { embeds, calls } = setup();
  const guild = { id: 'g' };
  const embed = await embeds.make('bob', guild);
  assert.deepEqual(JSON.parse(JSON.stringify(embed.toJSON())), {
    author: { name: 'bob', icon_url: 'https://cdn.example/avatars/bob.png' },
    color: 0x5865F2,
  });
  assert.deepEqual(calls, [['bob', guild]]);
});

test('the author name stays the username, not the display name', async () => {
  const { embeds } = setup();
  assert.equal((await embeds.make('bob', {})).data.author.name, 'bob');
});

test('omits the icon when the profile has no avatar', async () => {
  const { embeds } = setup(null);
  const embed = await embeds.make('bob', {});
  assert.equal(embed.data.author.name, 'bob');
  assert.ok(!embed.data.author.icon_url);
});

test('adds the thinking footer only when requested', async () => {
  const { embeds } = setup();
  const thinking = await embeds.make('bob', {}, { thinking: true });
  assert.equal(thinking.data.footer.text, 'thinking...');
  assert.equal((await embeds.make('bob', {}, { thinking: false })).data.footer, undefined);
  assert.equal((await embeds.make('bob', {})).data.footer, undefined);
});
