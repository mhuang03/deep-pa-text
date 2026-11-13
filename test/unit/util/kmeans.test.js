import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kmeans, clusterCount } from '../../../src/util/kmeans.js';
import { normaliseRow } from '../../../src/util/vectorMath.js';

const seeded = (seed) => {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const SEEDS = [1, 2, 3, 7, 42, 99, 12345];
const DIMENSIONS = 4;

const matrix = (rows) => {
  const vectors = Float32Array.from(rows.flat());
  for (let i = 0; i < rows.length; i += 1) normaliseRow(vectors, i * DIMENSIONS, DIMENSIONS);
  return vectors;
};

const GROUPS = [
  [[1, 0.05, 0, 0], [1, 0, 0.05, 0], [1, 0.02, 0.02, 0], [1, 0.04, 0, 0.01]],
  [[0, 1, 0.05, 0], [0.05, 1, 0, 0], [0, 1, 0.02, 0.02], [0, 1, 0, 0.04]],
  [[0, 0.05, 1, 0], [0, 0, 1, 0.05], [0.02, 0, 1, 0.02], [0, 0.01, 1, 0.04]],
];
const ROWS = GROUPS.flat();

const run = (seed, overrides = {}) => kmeans({
  vectors: matrix(ROWS), dimensions: DIMENSIONS, clusters: 3, iterations: 15, random: seeded(seed), ...overrides,
});

test('finds three well separated groups for each seed in a fixed list', () => {
  SEEDS.forEach((seed) => {
    const { assignments } = run(seed);
    const labels = GROUPS.map((_, g) => new Set([...assignments.slice(g * 4, g * 4 + 4)]));
    labels.forEach((set) => assert.equal(set.size, 1, `seed ${seed}`));
    assert.equal(new Set(labels.map((set) => [...set][0])).size, 3, `seed ${seed}`);
  });
});

test('is deterministic for a fixed random source', () => {
  const a = run(5);
  const b = run(5);
  assert.deepEqual([...a.assignments], [...b.assignments]);
  assert.deepEqual([...a.centroids], [...b.centroids]);
  assert.deepEqual([...a.cohesion], [...b.cohesion]);
});

test('cohesion is the mean similarity of each cluster to its centre', () => {
  const { assignments, cohesion } = run(3);
  assert.equal(cohesion.length, 3);
  cohesion.forEach((value) => assert.ok(value > 0.99 && value <= 1.0001, String(value)));
  assert.equal(new Set(assignments).size, 3);
});

test('a single row with one cluster works and has cohesion one', () => {
  const result = kmeans({ vectors: matrix([[0, 3, 4, 0]]), dimensions: DIMENSIONS, clusters: 1, iterations: 5, random: seeded(1) });
  assert.deepEqual([...result.assignments], [0]);
  assert.ok(Math.abs(result.cohesion[0] - 1) < 1e-6);
});

test('fewer rows than clusters reduces the cluster count to the row count', () => {
  const result = kmeans({ vectors: matrix(ROWS.slice(0, 2)), dimensions: DIMENSIONS, clusters: 5, iterations: 5, random: seeded(1) });
  assert.equal(result.cohesion.length, 2);
  assert.equal(result.centroids.length, 2 * DIMENSIONS);
});

test('no rows gives empty results', () => {
  const result = kmeans({ vectors: new Float32Array(0), dimensions: DIMENSIONS, clusters: 3, iterations: 5, random: seeded(1) });
  assert.equal(result.assignments.length, 0);
  assert.equal(result.cohesion.length, 0);
});

test('identical rows draw the remaining centres uniformly and leave empty clusters with cohesion zero', () => {
  const same = matrix([[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]]);
  const result = kmeans({ vectors: same, dimensions: DIMENSIONS, clusters: 3, iterations: 5, random: seeded(4) });
  assert.equal(result.assignments.length, 3);
  assert.ok(result.cohesion.every((value) => value === 0 || Math.abs(value - 1) < 1e-6));
});

test('an empty centre is re-seeded from a row, so every cluster ends non-empty', () => {
  // Two duplicated rows and k = 3: the third centre is drawn uniformly (nothing is left to separate) and
  // duplicates an existing one, so it attracts no row until it is re-seeded.
  const rows = [[1, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0]];
  const picks = [0, 0.4, 0, 0];
  let i = 0;
  const random = () => picks[Math.min(i++, picks.length - 1)];
  const { assignments, cohesion } = kmeans({
    vectors: matrix(rows), dimensions: DIMENSIONS, clusters: 3, iterations: 10, random,
  });
  assert.equal(new Set(assignments).size, 3);
  assert.ok(cohesion.every((value) => value > 0.99));
});

test('stops early once no assignment changes', () => {
  let calls = 0;
  const random = () => {
    calls += 1;
    return 0.5;
  };
  const few = run(1, { iterations: 1000, random });
  assert.equal(new Set(few.assignments).size > 0, true);
  assert.ok(calls < 20, 'the only randomness is seeding, which is finite');
});

test('a mean of zero length keeps the previous centre', () => {
  const rows = [[1, 0, 0, 0], [-1, 0, 0, 0]];
  const result = kmeans({ vectors: matrix(rows), dimensions: DIMENSIONS, clusters: 1, iterations: 3, random: seeded(1) });
  const length = Math.hypot(...result.centroids);
  assert.ok(Math.abs(length - 1) < 1e-6);
});

test('clusterCount takes the square root of count over the divisor, clamped, never more than count', () => {
  const settings = { clusterDivisor: 2, minClusters: 5, maxClusters: 120 };
  assert.equal(clusterCount(200, settings), 10);
  assert.equal(clusterCount(2000, settings), 32);
  assert.equal(clusterCount(30000, settings), 120);
  assert.equal(clusterCount(50, settings), 5);
  assert.equal(clusterCount(3, settings), 3);
  assert.equal(clusterCount(0, settings), 0);
  assert.equal(clusterCount(1000000, settings), 120);
});
