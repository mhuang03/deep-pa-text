import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorEmbeds } from '../../../src/discord/authorEmbed.js';
import { loadConfig } from '../../../src/config.js';
import { createFakeDiscord } from '../../support/fakes/discord.js';

const setup = () => {
  const { state } = createFakeDiscord();
  const warnings = [];
  const embeds = createAuthorEmbeds({
    config: loadConfig({}),
    logger: { warn: (...args) => warnings.push(args) },
  });
  return { guild: state.guild, embeds, warnings };
};

test('builds an author embed with the member avatar and brand colour', async () => {
  const { guild, embeds } = setup();
  const embed = await embeds.make('bob', guild);
  assert.deepEqual(JSON.parse(JSON.stringify(embed.toJSON())), {
    author: { name: 'bob', icon_url: 'https://cdn.example/avatars/bob.png' },
    color: 0x5865F2,
  });
  assert.deepEqual(guild.members.calls, [{ query: 'bob', limit: 1 }]);
});

test('omits the icon when the member is missing', async () => {
  const { guild, embeds, warnings } = setup();
  guild.members.setMissing(true);
  const embed = await embeds.make('bob', guild);
  assert.equal(embed.data.author.name, 'bob');
  assert.ok(!embed.data.author.icon_url);
  assert.deepEqual(warnings, []);
});

test('logs a warning and omits the icon when the lookup fails', async () => {
  const { guild, embeds, warnings } = setup();
  guild.members.setFailing(true);
  const embed = await embeds.make('bob', guild);
  assert.ok(!embed.data.author.icon_url);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /bob/);
  assert.match(warnings[0][1].message, /member fetch failed/);
});

test('adds the thinking footer only when requested', async () => {
  const { guild, embeds } = setup();
  const thinking = await embeds.make('bob', guild, { thinking: true });
  assert.equal(thinking.data.footer.text, 'thinking...');
  assert.equal((await embeds.make('bob', guild, { thinking: false })).data.footer, undefined);
  assert.equal((await embeds.make('bob', guild)).data.footer, undefined);
});
