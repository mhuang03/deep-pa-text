import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { buildPayload, withSafeMentions, SAFE_MENTIONS } from '../../../src/discord/payload.js';

const author = new EmbedBuilder().setAuthor({ name: 'bob' });

test('puts gif image embeds first, in link order, then the author embed', () => {
  const payload = buildPayload({
    content: 'hi',
    gifLinks: [{ match: 'a', url: 'https://x/1.gif' }, { match: 'b', url: 'https://x/2.gif' }],
    authorEmbed: author,
  });
  assert.equal(payload.content, 'hi');
  assert.deepEqual(payload.embeds.map((e) => e.data.image?.url), ['https://x/1.gif', 'https://x/2.gif', undefined]);
  assert.equal(payload.embeds[2], author);
});

test('omits links without a url', () => {
  const payload = buildPayload({
    content: 'c',
    gifLinks: [{ match: 'a', url: '' }, { match: 'b', url: 'https://x/2.gif' }],
    authorEmbed: author,
  });
  assert.equal(payload.embeds.length, 2);
  assert.equal(payload.embeds[0].data.image.url, 'https://x/2.gif');
});

test('with no links only the author embed remains', () => {
  const payload = buildPayload({ content: 'c', gifLinks: [], authorEmbed: author });
  assert.deepEqual(payload.embeds, [author]);
});

test('does not mutate the gifLinks input', () => {
  const gifLinks = [{ match: 'a', url: 'https://x/u.gif' }];
  buildPayload({ content: 'c', gifLinks, authorEmbed: author });
  assert.deepEqual(gifLinks, [{ match: 'a', url: 'https://x/u.gif' }]);
});

test('SAFE_MENTIONS parses nothing', () => {
  assert.deepEqual(SAFE_MENTIONS, { parse: [] });
});

test('withSafeMentions adds a non-parsing allowedMentions with the repliedUser flag', () => {
  [true, false].forEach((repliedUser) => {
    const payload = withSafeMentions({ content: 'hi' }, { repliedUser });
    assert.deepEqual(payload, { content: 'hi', allowedMentions: { parse: [], repliedUser } });
  });
});

test('withSafeMentions leaves out repliedUser when none is given', () => {
  assert.deepEqual(withSafeMentions({ content: 'hi' }).allowedMentions, { parse: [] });
  assert.equal('repliedUser' in withSafeMentions({}, {}).allowedMentions, false);
});

test('withSafeMentions does not mutate its input and replaces an existing allowedMentions', () => {
  const input = { content: 'hi', allowedMentions: { parse: ['everyone'] } };
  const output = withSafeMentions(input, { repliedUser: true });
  assert.deepEqual(input, { content: 'hi', allowedMentions: { parse: ['everyone'] } });
  assert.notEqual(output, input);
  assert.deepEqual(output.allowedMentions.parse, []);
});

test('buildPayload without an author embed returns only the GIF embeds', () => {
  const payload = buildPayload({ content: 'x', gifLinks: [{ match: 'm', url: 'https://x/a.gif' }, { match: 'n', url: null }] });
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].data.image.url, 'https://x/a.gif');
  assert.deepEqual(buildPayload({ content: 'x', gifLinks: [] }).embeds, []);
});

const gifs = (count) => Array.from({ length: count }, (_, i) => ({ match: `m${i}`, url: `https://x/${i}.gif` }));

test('never carries more embeds than the maximum: the author embed keeps its slot', () => {
  const payload = buildPayload({ content: 'c', gifLinks: gifs(12), authorEmbed: author, maxEmbeds: 10 });
  assert.equal(payload.embeds.length, 10);
  assert.equal(payload.embeds.at(-1), author);
  assert.equal(payload.embeds.filter((e) => e.data.image).length, 9);
});

test('without an author embed all ten slots can hold images, and the default maximum is ten', () => {
  assert.equal(buildPayload({ content: 'c', gifLinks: gifs(12), authorEmbed: null }).embeds.length, 10);
  assert.equal(buildPayload({ content: 'c', gifLinks: gifs(12), authorEmbed: null, maxEmbeds: 3 }).embeds.length, 3);
  assert.equal(buildPayload({ content: 'c', gifLinks: gifs(2), authorEmbed: author, maxEmbeds: 1 }).embeds.length, 1);
});
