import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripLinks } from '../../../src/util/links.js';

const ROWS = [
  ['check [free nitro](http://phish.example) now', 'check free nitro now'],
  ['[x](<http://e.example>)', 'x'],
  ['[x](HTTP://e.example)', 'x'],
  ['[x](http://a.example/p_(1))', 'x'],
  ['[x](https://a.example "title")', 'x'],
  ['[x](ftp://files.example/a)', 'x'],
  ['see https://example.com/a?b=1 ok', 'see  ok'],
  ['see <https://example.com> ok', 'see  ok'],
  ['see HTTPS://EXAMPLE.COM ok', 'see  ok'],
  ['see ftp://example.com/x ok', 'see  ok'],
  ['see www.e.example/x ok', 'see  ok'],
  ['join discord.gg/abc now', 'join  now'],
  ['join discord.com/invite/abc now', 'join  now'],
  ['join discordapp.com/invite/abc now', 'join  now'],
  ['join dsc.gg/abc now', 'join  now'],
  ['join https://discord.gg/abc now', 'join  now'],
  ['https://example.com', ''],
  ['nothing to remove here', 'nothing to remove here'],
  ['a [plain bracket] and (parens)', 'a [plain bracket] and (parens)'],
];

for (const [input, expected] of ROWS) {
  test(`stripLinks(${JSON.stringify(input)})`, () => {
    assert.equal(stripLinks(input), expected);
  });
}

test('no link survives in any supported form', () => {
  const output = stripLinks(ROWS.map(([input]) => input).join(' '));
  assert.doesNotMatch(output, /:\/\/|www\.|discord\.gg|dsc\.gg|\/invite\//i);
});
