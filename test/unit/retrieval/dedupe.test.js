import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeBuckets } from '../../../src/retrieval/dedupe.js';
import { fakeEmbed } from '../../support/fakes/chroma.js';

const OPTIONS = { nearDuplicateThreshold: 0.95, nearDuplicateMinChars: 12 };
const cand = (id, text, embedding = null) => ({ id, text, embedding });
const texts = (buckets) => buckets.map((bucket) => bucket.map((item) => item.text));

test('merges candidates whose normalised keys are equal and lists every variant', () => {
  const input = ['lol', 'LOL', 'lol ', 'lolll', 'lol!!'].map((t, i) => cand(`${i}`, t));
  const [bucket] = dedupeBuckets([input], OPTIONS);
  assert.equal(bucket.length, 1);
  assert.deepEqual(bucket[0].variants, ['lol', 'LOL', 'lol ', 'lolll', 'lol!!']);
  assert.equal(bucket[0].id, '0');
});

test('distinct keys stay distinct', () => {
  const pairs = [['cool', 'col'], ['1000', '10'], ['$500', '$50'], ['>:(', '>:)'], ['???', '!!!']];
  pairs.forEach(([a, b]) => {
    assert.equal(dedupeBuckets([[cand('1', a), cand('2', b)]], OPTIONS)[0].length, 2, `${a} ${b}`);
  });
});

test('gif tokens are compared whole', () => {
  assert.equal(dedupeBuckets([[cand('1', '<gif! cat>'), cand('2', '<gif! CAT>')]], OPTIONS)[0].length, 1);
  assert.equal(dedupeBuckets([[cand('1', '<gif! cat>'), cand('2', '<gif! cat!>')]], OPTIONS)[0].length, 2);
});

test('merges long texts by embedding but never short ones', () => {
  const long = [cand('1', 'ok see you tomorrow then', fakeEmbed('ok see you tomorrow then')),
    cand('2', 'see you tomorrow then ok', fakeEmbed('see you tomorrow then ok'))];
  assert.equal(dedupeBuckets([long], OPTIONS)[0].length, 1);
  const short = [cand('1', 'sounds good', fakeEmbed('sounds good')), cand('2', 'good sounds', fakeEmbed('good sounds'))];
  assert.equal(dedupeBuckets([short], OPTIONS)[0].length, 2);
});

test('candidates without embeddings use key dedup only', () => {
  const input = [cand('1', 'ok see you tomorrow then'), cand('2', 'see you tomorrow then ok')];
  assert.equal(dedupeBuckets([input], OPTIONS)[0].length, 2);
});

test('the threshold is inclusive and just below it does not merge', () => {
  const a = cand('1', 'a long enough text', [1, 0]);
  const b = cand('2', 'another long enough', [0.95, Math.sqrt(1 - 0.95 ** 2)]);
  const at = { ...OPTIONS, nearDuplicateThreshold: 0.95 };
  assert.equal(dedupeBuckets([[a, b]], { ...at, nearDuplicateThreshold: 0.9500000001 })[0].length, 2);
  assert.equal(dedupeBuckets([[a, b]], { ...at, nearDuplicateThreshold: 0.95 - 1e-9 })[0].length, 1);
});

test('an earlier bucket suppresses later variants and the kept item keeps its bucket', () => {
  const out = dedupeBuckets([[cand('1', 'lol')], [cand('2', 'LOL'), cand('3', 'other')], [cand('4', 'lol!')]], OPTIONS);
  assert.deepEqual(texts(out), [['lol'], ['other'], []]);
  assert.deepEqual(out[0][0].variants, ['lol', 'LOL', 'lol!']);
});

test('an identical text merges without repeating the variant', () => {
  const [bucket] = dedupeBuckets([[cand('1', 'same'), cand('2', 'same')]], OPTIONS);
  assert.deepEqual(bucket[0].variants, ['same']);
});

test('handles empty input', () => {
  assert.deepEqual(dedupeBuckets([[], [cand('1', 'a')], []], OPTIONS).map((b) => b.length), [0, 1, 0]);
  assert.deepEqual(dedupeBuckets([], OPTIONS), []);
});

test('does not mutate its input', () => {
  const input = [[cand('1', 'lol'), cand('2', 'LOL')]];
  const copy = structuredClone(input);
  const out = dedupeBuckets(input, OPTIONS);
  assert.deepEqual(input, copy);
  assert.notEqual(out[0][0], input[0][0]);
  assert.equal(input[0][0].variants, undefined);
});
