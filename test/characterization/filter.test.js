import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';

const newWorld = async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  return world;
};

const msg = (content, author = 'alice') => ({
  id: 'm1',
  author,
  content,
  timestamp: 1_000,
  reference: null,
});

const ROWS = [
  ['replaces a user mention with the cached username', '<@111> hello there', '@alice hello there'],
  ['replaces a nickname-style mention <@!id>', '<@!222> hello there', '@bob hello there'],
  ['drops an unknown user mention', '<@999> hello there', 'hello there'],
  ['drops a message that is only mentions', '<@111> <@222>', null],
  ['replaces a role mention with the cached role', '<@&333> assemble now', '@mods assemble now'],
  ['replaces a channel mention with the cached channel', 'see <#444> please', 'see #general please'],
  ['converts a tenor link to a gif token', 'https://tenor.com/view/funny-cat-dance-gif-12345', '<gif! funny cat dance>'],
  ['converts a tenor link with a query string', 'https://tenor.com/view/cat-cat-jump-gif-99?x=1', '<gif! cat jump>'],
  ['converts a tenor link in the middle of text, dropping tenor and gif words', 'lol https://tenor.com/view/tenor-wow-gif-5 nice', 'lol <gif! wow> nice'],
  ['keeps markdown link text and drops the url', 'check [this site](https://example.com/x) out', 'check this site out'],
  ['removes a bare url', 'look at https://example.com/page now', 'look at now'],
  ['drops a message that is only a url', 'https://example.com/only', null],
  ['removes an angle-bracketed url', 'see <https://example.com> right now', 'see right now'],
  ['converts a custom emoji to its name', 'nice <:pog:12345> one', 'nice :pog: one'],
  ['converts an animated custom emoji to its name', '<a:dance:999> party time', ':dance: party time'],
  ['removes dynamic time objects', 'meet at <t:1700000000:R> okay', 'meet at  okay'],
  ['removes soundboard objects', 'listen <:sound:12:34> to this', 'listen  to this'],
  ['removes discord invite links', 'join discord.gg/abc123 everyone', 'join  everyone'],
  ['trims surrounding whitespace', '   padded text   ', 'padded text'],
  ['drops content shorter than 5 characters', 'abcd', null],
  ['keeps content of exactly 5 characters', 'abcde', 'abcde'],
  ['keeps content of exactly 200 characters', 'a'.repeat(200), 'a'.repeat(200)],
  ['drops content longer than 200 characters', 'a'.repeat(201), null],
  ...['!play song', '$balance now', '#hashtag thing', '%stuff here', '&thing here', '-minus thing', '+plus thing', 'p!catch it'].map((c) => [
    `drops bot command "${c}"`,
    c,
    null,
  ]),
  ['drops a Connections share', 'Connections today was hard', null],
  ['drops a Puzzle # share', 'Puzzle #512 done', null],
  ['drops a Wordle share', 'Wordle 1234 4/6 nice', null],
  ['drops a Strands share', 'Strands #123 easy', null],
  ['drops empty content', '', null],
  ['drops undefined content', undefined, null],
  ['drops null content', null, null],
];

for (const [name, content, expected] of ROWS) {
  test(`${name} (filter and filterAnyAuthor agree for an approved author)`, async (t) => {
    const world = await newWorld(t);
    const kept = await world.subject.filter(msg(content));
    const keptAny = await world.subject.filterAnyAuthor(msg(content));
    assert.equal(kept === null ? null : kept.content, expected);
    assert.equal(keptAny === null ? null : keptAny.content, expected);
  });
}

test('a kept message keeps id, author, timestamp and reference and gets transformed content', async (t) => {
  const world = await newWorld(t);
  const input = { id: 'abc', author: 'bob', content: '<@111> hello there', timestamp: 12345, reference: 'ref1' };
  const out = world.subject.filter(input);
  assert.equal(out.id, 'abc');
  assert.equal(out.author, 'bob');
  assert.equal(out.timestamp, 12345);
  assert.equal(out.reference, 'ref1');
  assert.equal(out.content, '@alice hello there');
});

test('filter drops a non-approved author while filterAnyAuthor keeps the same message', async (t) => {
  const world = await newWorld(t);
  assert.equal(world.subject.filter(msg('hello there friends', 'mallory')), null);
  const kept = world.subject.filterAnyAuthor(msg('hello there friends', 'mallory'));
  assert.equal(kept.content, 'hello there friends');
  assert.equal(kept.author, 'mallory');
});
