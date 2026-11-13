import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectClusters } from '../../../src/topics/clusterFilter.js';

const SETTINGS = {
  minClusterSize: 4, minAuthors: 3, minMedianChars: 20, maxAuthorShare: 0.6, maxPrefixShare: 0.3, maxLabelled: 10,
};
const LONG = (n) => `message number ${n} with enough distinct text in it`;

const rowsFor = (authors, content = LONG) => authors.map((author, i) => ({
  author, content: content(i), timestamp: 100 + i,
}));

const select = (rows, assignments, overrides = {}) => selectClusters({
  rows, assignments: Int32Array.from(assignments), cohesion: Float32Array.from(new Set(assignments).size ? [0.5, 0.6, 0.7, 0.8] : []),
  directorySize: 4, settings: { ...SETTINGS, ...overrides.settings }, ...overrides.rest,
});

const AUTHORS = ['a', 'b', 'c', 'd'];

test('keeps a cluster that passes every rule and describes it', () => {
  const [cluster] = select(rowsFor(AUTHORS), [0, 0, 0, 0]);
  assert.equal(cluster.size, 4);
  assert.equal(cluster.authorCount, 4);
  assert.equal(cluster.cohesion, 0.5);
  assert.equal(cluster.medianTimestamp, 101.5);
  assert.deepEqual(cluster.members, [0, 1, 2, 3]);
  assert.equal(cluster.authors[0].share, 0.25);
});

test('drops a cluster below the minimum size, at the boundary of the size rule', () => {
  assert.equal(select(rowsFor(['a', 'b', 'c']), [0, 0, 0]).length, 0);
  assert.equal(select(rowsFor(AUTHORS), [0, 0, 0, 0]).length, 1);
});

test('requires distinct authors, capped by the number of people in the directory', () => {
  const two = rowsFor(['a', 'b', 'a', 'b']);
  assert.equal(select(two, [0, 0, 0, 0]).length, 0);
  assert.equal(select(two, [0, 0, 0, 0], { rest: { directorySize: 2 } }).length, 1);
  assert.equal(select(rowsFor(['a', 'a', 'a', 'a']), [0, 0, 0, 0], { rest: { directorySize: 2 } }).length, 0);
});

test('requires a median text length', () => {
  const short = rowsFor(AUTHORS, (n) => `tiny ${n}`);
  assert.equal(select(short, [0, 0, 0, 0]).length, 0);
  assert.equal(select(short, [0, 0, 0, 0], { settings: { minMedianChars: 0 } }).length, 1);
});

test('drops a cluster where one author wrote more than the maximum share', () => {
  const rows = rowsFor(['a', 'a', 'a', 'b', 'c']);
  assert.equal(select(rows, [0, 0, 0, 0, 0]).length, 1, 'exactly at the limit (3 of 5) passes');
  const heavy = rowsFor(['a', 'a', 'a', 'a', 'b', 'c']);
  assert.equal(select(heavy, [0, 0, 0, 0, 0, 0]).length, 0);
});

test('drops a cluster dominated by one three-word opening', () => {
  const template = rowsFor(AUTHORS, (n) => `anyone want to play game ${n} tonight`);
  assert.equal(select(template, [0, 0, 0, 0]).length, 0);
  const varied = rowsFor(AUTHORS, (n) => (n === 0 ? `anyone want to play game ${n} tonight` : LONG(n)));
  assert.equal(select(varied, [0, 0, 0, 0]).length, 1);
});

test('orders by size, largest first, and cuts to maxLabelled', () => {
  const rows = [...rowsFor(AUTHORS), ...rowsFor([...AUTHORS, 'e', 'f'], (n) => `different text ${n} about another subject`)];
  const assignments = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
  const kept = select(rows, assignments, { rest: { cohesion: Float32Array.from([0.9, 0.2]) } });
  assert.deepEqual(kept.map((c) => c.size), [6, 4]);
  const cut = select(rows, assignments, { settings: { maxLabelled: 1 }, rest: { cohesion: Float32Array.from([0.9, 0.2]) } });
  assert.deepEqual(cut.map((c) => c.index), [1]);
});

test('an empty cluster is skipped', () => {
  const kept = select(rowsFor(AUTHORS), [1, 1, 1, 1], { rest: { cohesion: Float32Array.from([0, 0.7]) } });
  assert.deepEqual(kept.map((c) => c.index), [1]);
});
