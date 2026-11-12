import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { buildPayload } from '../../../src/discord/payload.js';

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
