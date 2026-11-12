import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransformers } from '../../../src/corpus/transformers.js';
import { PING_CACHE } from '../../support/fixtures.js';

const transformers = createTransformers({ pingCache: PING_CACHE });
const apply = (name, text) => transformers.find((t) => t.name === name).apply(text);

test('transformers keep the legacy order and names', () => {
  assert.deepEqual(transformers.map((t) => t.name), [
    'handleMentions', 'handleTenor', 'removeUrls', 'replaceCustomEmojis',
    'removeDynamicTimeObjects', 'removeSoundboards', 'removeDiscordLinks', 'trim',
  ]);
});

test('handleMentions resolves users, roles and channels', () => {
  assert.equal(apply('handleMentions', '<@111> hi <@!222> <@&333> <#444>'), '@alice hi @bob @mods #general');
});

test('handleMentions drops unknown ids', () => {
  assert.equal(apply('handleMentions', '<@999> hi <@&999> <#999>'), ' hi  ');
});

test('handleMentions empties mention-only messages', () => {
  assert.equal(apply('handleMentions', '<@111> <@222>\n<#444>'), '');
  assert.equal(apply('handleMentions', '<@999>'), '');
});

test('handleTenor builds a gif token without the tenor and gif words', () => {
  assert.equal(apply('handleTenor', 'https://tenor.com/view/funny-cat-dance-gif-12345'), '<gif! funny cat dance>');
  assert.equal(apply('handleTenor', 'https://tenor.com/view/cat-cat-jump-gif-99?x=1'), '<gif! cat jump>');
  assert.equal(apply('handleTenor', 'a https://tenor.com/view/tenor-wow-gif-5 b'), 'a <gif! wow> b');
});

test('handleTenor leaves other text alone', () => {
  assert.equal(apply('handleTenor', 'https://tenor.com/other/x-1'), 'https://tenor.com/other/x-1');
});

test('removeUrls unwraps markdown links and drops bare and bracketed urls', () => {
  assert.equal(apply('removeUrls', 'check [this site](https://example.com/x) out'), 'check this site out');
  assert.equal(apply('removeUrls', 'look at https://example.com/page now'), 'look at now');
  assert.equal(apply('removeUrls', 'see <https://example.com> right now'), 'see right now');
  assert.equal(apply('removeUrls', 'https://example.com/only'), '');
});

test('removeUrls rejoins a url split by a newline after the scheme', () => {
  assert.equal(apply('removeUrls', 'x https://\nexample.com/a y'), 'x y');
});

test('removeUrls keeps words that are not valid urls', () => {
  assert.equal(apply('removeUrls', 'weird ://nothing here'), 'weird ://nothing here');
  assert.equal(apply('removeUrls', 'no links at all'), 'no links at all');
});

test('removeUrls removes a url followed by a newline', () => {
  assert.equal(apply('removeUrls', 'a\nhttps://example.com/z\nb'), 'a\nb');
});

test('replaceCustomEmojis keeps the emoji name', () => {
  assert.equal(apply('replaceCustomEmojis', 'a <:pog:12345> b <a:dance:999>'), 'a :pog: b :dance:');
});

test('removeDynamicTimeObjects removes timestamps with and without style', () => {
  assert.equal(apply('removeDynamicTimeObjects', 'a <t:1700000000:R> b <t:1700000000> c'), 'a  b  c');
});

test('removeSoundboards removes soundboard tokens', () => {
  assert.equal(apply('removeSoundboards', 'a <:sound:12:34> b'), 'a  b');
});

test('removeDiscordLinks removes invites with or without scheme', () => {
  assert.equal(apply('removeDiscordLinks', 'join discord.gg/abc123 now'), 'join  now');
  assert.equal(apply('removeDiscordLinks', 'join https://www.discord.gg/abc now'), 'join  now');
});

test('trim strips surrounding whitespace', () => {
  assert.equal(apply('trim', '  a b \n'), 'a b');
});

test('pingCache lookups are per instance', () => {
  const other = createTransformers({ pingCache: { users: { 111: 'zed' }, roles: {}, channels: {} } });
  assert.equal(other[0].apply('<@111> hi'), '@zed hi');
  assert.equal(apply('handleMentions', '<@111> hi'), '@alice hi');
});
