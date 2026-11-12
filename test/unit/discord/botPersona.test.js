import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { readPersonaFromEmbeds } from '../../../src/discord/botPersona.js';

const directory = { usernames: new Set(['alice', 'bob']) };
const built = (name) => new EmbedBuilder().setAuthor({ name });

test('reads the persona from a builder embed', () => {
  assert.equal(readPersonaFromEmbeds({ embeds: [built('alice')] }, directory), 'alice');
});

test('reads the persona from a received embed', () => {
  assert.equal(readPersonaFromEmbeds({ embeds: [{ author: { name: 'bob' } }] }, directory), 'bob');
});

test('uses the last embed that has an author', () => {
  const embeds = [built('alice'), { image: { url: 'u' } }, built('bob'), { title: 't' }];
  assert.equal(readPersonaFromEmbeds({ embeds }, directory), 'bob');
});

test('an unknown author name gives null', () => {
  assert.equal(readPersonaFromEmbeds({ embeds: [built('mallory')] }, directory), null);
});

test('no embeds gives null', () => {
  assert.equal(readPersonaFromEmbeds({ embeds: [] }, directory), null);
  assert.equal(readPersonaFromEmbeds({}, directory), null);
});
