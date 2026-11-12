const MISSING_SIMILARITY = 0.5;
const HALF_LIFE_BASE = 0.5;
const MAX_ROLL = 1 - Number.EPSILON;

const similarityOf = (distance) =>
  Number.isFinite(distance) ? 1 / (1 + Math.max(0, distance)) : MISSING_SIMILARITY;

const recencyOf = (timestamp, { referenceTimeMs, halfLifeMs, minRecency }) => {
  if (!Number.isFinite(timestamp)) return minRecency;
  const ageMs = Math.max(0, referenceTimeMs - timestamp);
  return Math.max(minRecency, HALF_LIFE_BASE ** (ageMs / halfLifeMs));
};

export const hitWeight = (hit, options) =>
  similarityOf(hit.distance) * recencyOf(hit.metadata?.timestamp, options);

const isCountable = (hit, allowedAuthors) => {
  const author = hit.metadata?.author;
  return Boolean(author) && allowedAuthors.includes(author);
};

export const weighAuthors = (hits, { allowedAuthors, ...options }) => {
  const totals = new Map();
  hits.filter((hit) => isCountable(hit, allowedAuthors)).forEach((hit) => {
    const author = hit.metadata.author;
    totals.set(author, (totals.get(author) ?? 0) + hitWeight(hit, options));
  });
  return [...totals].map(([author, weight]) => ({ author, weight }));
};

const clampRoll = (roll) => Math.min(Math.max(roll, 0), MAX_ROLL);

export const pickWeighted = (entries, roll) => {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return undefined;
  const target = clampRoll(roll) * total;
  let cumulative = 0;
  const found = entries.find((entry) => {
    cumulative += entry.weight;
    return cumulative > target;
  });
  return (found ?? entries.at(-1)).author;
};
