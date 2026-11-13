import { createRowDot, normaliseRow } from './vectorMath.js';

// Spherical k-means on unit rows: similarity is the dot product, centres are normalised means.
// All randomness comes from the injected `random`, so a fixed source gives a fixed result.

export const clusterCount = (count, { clusterDivisor, minClusters, maxClusters }) => {
  const wanted = Math.round(Math.sqrt(count / clusterDivisor));
  return Math.min(count, Math.max(minClusters, Math.min(maxClusters, wanted)));
};

// Makes `centre` a copy of `row`.
const setCentre = (ctx, row, centre) => {
  const { vectors, dimensions, centroids } = ctx;
  centroids.set(vectors.subarray(row * dimensions, (row + 1) * dimensions), centre * dimensions);
};

// The next centre is drawn with probability proportional to how far a row is from its nearest centre.
const drawSeed = ({ count, random }, nearest) => {
  const weights = Array.from(nearest, (similarity) => Math.max(0, 1 - similarity));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return Math.min(count - 1, Math.floor(random() * count));
  const target = random() * total;
  let cumulative = 0;
  let last = 0;
  for (let row = 0; row < count; row += 1) {
    if (weights[row] === 0) continue;
    last = row;
    cumulative += weights[row];
    if (target < cumulative) return row;
  }
  return last;
};

const seedCentroids = (ctx) => {
  const { count, clusters, random, similarity } = ctx;
  const nearest = new Float32Array(count).fill(-Infinity);
  let chosen = Math.min(count - 1, Math.floor(random() * count));
  for (let centre = 0; centre < clusters; centre += 1) {
    setCentre(ctx, chosen, centre);
    for (let row = 0; row < count; row += 1) nearest[row] = Math.max(nearest[row], similarity(row, centre));
    if (centre + 1 < clusters) chosen = drawSeed(ctx, nearest);
  }
};

// Returns how many rows changed cluster; `similarities` holds each row's similarity to its own centre.
const assign = (ctx, state) => {
  const { count, clusters, similarity } = ctx;
  let changed = 0;
  for (let row = 0; row < count; row += 1) {
    let best = 0;
    let bestSimilarity = -Infinity;
    for (let centre = 0; centre < clusters; centre += 1) {
      const value = similarity(row, centre);
      if (value > bestSimilarity) {
        best = centre;
        bestSimilarity = value;
      }
    }
    if (state.assignments[row] !== best) changed += 1;
    state.assignments[row] = best;
    state.similarities[row] = bestSimilarity;
  }
  return changed;
};

const sumRows = (ctx, assignments) => {
  const { count, clusters, dimensions, vectors } = ctx;
  const sums = new Float32Array(clusters * dimensions);
  const sizes = new Int32Array(clusters);
  for (let row = 0; row < count; row += 1) {
    const centre = assignments[row];
    sizes[centre] += 1;
    for (let d = 0; d < dimensions; d += 1) sums[centre * dimensions + d] += vectors[row * dimensions + d];
  }
  return { sums, sizes };
};

// The row least similar to its own centre that no other empty centre has taken this round.
const farthestUnused = (ctx, state, used) => {
  let found = -1;
  for (let row = 0; row < ctx.count; row += 1) {
    if (used.has(row)) continue;
    if (found < 0 || state.similarities[row] < state.similarities[found]) found = row;
  }
  return found;
};

const reseed = (ctx, state, centre) => {
  const row = farthestUnused(ctx, state, state.used);
  if (row < 0) return false;
  state.used.add(row);
  setCentre(ctx, row, centre);
  state.assignments[row] = centre;
  state.similarities[row] = 1;
  return true;
};

// Returns true when an empty centre had to be re-seeded.
const updateCentroids = (ctx, state) => {
  const { clusters, dimensions, centroids } = ctx;
  const { sums, sizes } = sumRows(ctx, state.assignments);
  state.used = new Set();
  const empty = [];
  for (let centre = 0; centre < clusters; centre += 1) {
    if (sizes[centre] === 0) {
      empty.push(centre);
      continue;
    }
    const mean = sums.slice(centre * dimensions, (centre + 1) * dimensions);
    // A mean of zero length (opposite rows) keeps the previous centre.
    if (normaliseRow(mean, 0, dimensions)) centroids.set(mean, centre * dimensions);
  }
  return empty.map((centre) => reseed(ctx, state, centre)).some(Boolean);
};

const cohesionOf = (ctx, assignments) => {
  const sums = new Float64Array(ctx.clusters);
  const sizes = new Int32Array(ctx.clusters);
  for (let row = 0; row < ctx.count; row += 1) {
    sums[assignments[row]] += ctx.similarity(row, assignments[row]);
    sizes[assignments[row]] += 1;
  }
  return Float32Array.from(sums, (sum, centre) => (sizes[centre] === 0 ? 0 : sum / sizes[centre]));
};

const iterate = (ctx, state) => {
  for (let round = 0; round < ctx.iterations; round += 1) {
    const changed = assign(ctx, state);
    const reseeded = updateCentroids(ctx, state);
    if (changed === 0 && !reseeded) break;
  }
};

export const kmeans = ({ vectors, dimensions, clusters, iterations, random }) => {
  const count = Math.floor(vectors.length / dimensions);
  if (count === 0) {
    return { assignments: new Int32Array(0), centroids: new Float32Array(0), cohesion: new Float32Array(0) };
  }
  const used = Math.min(clusters, count);
  const centroids = new Float32Array(used * dimensions);
  const similarity = createRowDot(vectors, centroids, dimensions);
  const ctx = { vectors, dimensions, count, clusters: used, iterations, random, centroids, similarity };
  seedCentroids(ctx);
  const state = { assignments: new Int32Array(count).fill(-1), similarities: new Float32Array(count), used: new Set() };
  iterate(ctx, state);
  return { assignments: state.assignments, centroids, cohesion: cohesionOf(ctx, state.assignments) };
};
