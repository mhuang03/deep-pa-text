import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitWeight, pickWeighted, weighAuthors } from '../../../src/retrieval/personaWeights.js';

const DAY = 86_400_000;
const HALF_LIFE = 100 * DAY;
const options = { referenceTimeMs: 1000 * DAY, halfLifeMs: HALF_LIFE, minRecency: 0.25 };
const hit = (author, distance, timestamp) => ({ distance, metadata: { author, timestamp } });
const NOW = options.referenceTimeMs;

test('hitWeight is 1 for distance 0 and age 0', () => {
  assert.equal(hitWeight(hit('bob', 0, NOW), options), 1);
});

test('hitWeight falls to 0.2 similarity at the largest distance', () => {
  assert.ok(Math.abs(hitWeight(hit('bob', 4, NOW), options) - 0.2) < 1e-12);
});

test('hitWeight treats negative distance as 0 and a future timestamp as age 0', () => {
  assert.equal(hitWeight(hit('bob', -3, NOW + DAY), options), 1);
});

test('hitWeight halves per half-life', () => {
  const weight = hitWeight(hit('bob', 0, NOW - HALF_LIFE), { ...options, minRecency: 0.01 });
  assert.ok(Math.abs(weight - 0.5) < 1e-12);
});

test('hitWeight never drops recency below the floor', () => {
  assert.equal(hitWeight(hit('bob', 0, NOW - 50 * HALF_LIFE), options), 0.25);
});

test('hitWeight uses 0.5 similarity for a missing or non-finite distance', () => {
  [undefined, NaN, Infinity, null].forEach((distance) => {
    assert.equal(hitWeight(hit('bob', distance, NOW), options), 0.5);
  });
});

test('hitWeight uses the floor for a missing or non-finite timestamp', () => {
  [undefined, NaN, Infinity].forEach((timestamp) => {
    assert.equal(hitWeight(hit('bob', 0, timestamp), options), 0.25);
  });
  assert.equal(hitWeight({ distance: 0 }, options), 0.25);
});

test('weighAuthors sums per author in order of first appearance', () => {
  const hits = [hit('carol', 0, NOW), hit('bob', 0, NOW), hit('carol', 0, NOW)];
  assert.deepEqual(
    weighAuthors(hits, { ...options, allowedAuthors: ['bob', 'carol'] }),
    [{ author: 'carol', weight: 2 }, { author: 'bob', weight: 1 }],
  );
});

test('weighAuthors skips hits without metadata or author and authors outside the directory', () => {
  const hits = [
    { distance: 0 }, { distance: 0, metadata: {} }, hit('ghost', 0, NOW), hit('bob', 0, NOW),
  ];
  assert.deepEqual(
    weighAuthors(hits, { ...options, allowedAuthors: ['bob'] }),
    [{ author: 'bob', weight: 1 }],
  );
  assert.deepEqual(weighAuthors([], { ...options, allowedAuthors: ['bob'] }), []);
});

test('weights, not hit counts, decide between authors', () => {
  const weak = Array.from({ length: 3 }, () => hit('bob', 4, NOW - 50 * HALF_LIFE));
  const strong = [hit('carol', 0, NOW)];
  const entries = weighAuthors([...weak, ...strong], { ...options, allowedAuthors: ['bob', 'carol'] });
  // bob: 3 * 0.2 * 0.25 = 0.15; carol: 1. Roll 0.2 would pick bob by count but carol by weight.
  assert.ok(Math.abs(entries[0].weight - 0.15) < 1e-12);
  assert.equal(pickWeighted(entries, 0.2), 'carol');
});

test('pickWeighted is undefined for an empty list or a non-positive or non-finite total', () => {
  assert.equal(pickWeighted([], 0.5), undefined);
  assert.equal(pickWeighted([{ author: 'a', weight: 0 }], 0.5), undefined);
  assert.equal(pickWeighted([{ author: 'a', weight: NaN }], 0.5), undefined);
  assert.equal(pickWeighted([{ author: 'a', weight: Infinity }], 0.5), undefined);
});

test('pickWeighted picks the first entry at roll 0 and the last just below 1', () => {
  const entries = [{ author: 'a', weight: 1 }, { author: 'b', weight: 2 }, { author: 'c', weight: 3 }];
  assert.equal(pickWeighted(entries, 0), 'a');
  assert.equal(pickWeighted(entries, 0.999999), 'c');
});

test('pickWeighted clamps rolls outside [0, 1)', () => {
  const entries = [{ author: 'a', weight: 1 }, { author: 'b', weight: 1 }];
  assert.equal(pickWeighted(entries, 1), 'b');
  assert.equal(pickWeighted(entries, 7), 'b');
  assert.equal(pickWeighted(entries, -1), 'a');
});

test('pickWeighted splits equal weights at 0.5', () => {
  const entries = [{ author: 'a', weight: 1 }, { author: 'b', weight: 1 }];
  assert.equal(pickWeighted(entries, 0.49), 'a');
  assert.equal(pickWeighted(entries, 0.5), 'b');
});

test('pickWeighted skips zero-weight entries and falls back to the last on rounding', () => {
  assert.equal(pickWeighted([{ author: 'a', weight: 0 }, { author: 'b', weight: 1 }], 0), 'b');
  assert.equal(pickWeighted([{ author: 'a', weight: 1 }, { author: 'b', weight: 1 }], NaN), 'b');
});
