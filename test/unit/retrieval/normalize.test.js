import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForDedup } from '../../../src/retrieval/normalize.js';

const TABLE = [
  ['lol', 'lol'], ['LOL', 'lol'], ['lol ', 'lol'], ['lolll', 'lol'], ['lol!!', 'lol'],
  ['cool', 'cool'], ['col', 'col'], ['1000', '1000'], ['10', '10'], ['$500', '500'], ['$50', '50'],
  ['<gif! cat>', '<gif! cat>'], ['<GIF! CAT>', '<gif! cat>'], ['<gif!  cat   >', '<gif! cat >'],
  ['<gif! caaat>', '<gif! caaat>'], ['>:(', '>:('], ['>:)', '>:)'], ['???', '???'], ['!!!', '!!!'],
  ['see you tomorrow', 'see you tomorrow'], ['see you tomorrow!', 'see you tomorrow'],
  ['  a\t\nb  ', 'a b'], ['ＬＯＬ', 'lol'], ['héééé', 'hé'], ['😂😂', '😂😂'], ['', ''],
];

for (const [input, expected] of TABLE) {
  test(`normalizeForDedup(${JSON.stringify(input)}) is ${JSON.stringify(expected)}`, () => {
    assert.equal(normalizeForDedup(input), expected);
  });
}

test('normalizeForDedup is idempotent', () => {
  TABLE.forEach(([input]) => {
    const once = normalizeForDedup(input);
    assert.equal(normalizeForDedup(once), once);
  });
});

test('runs of two letters are kept and runs of three collapse', () => {
  assert.equal(normalizeForDedup('woow'), 'woow');
  assert.equal(normalizeForDedup('wooow'), 'wow');
});
