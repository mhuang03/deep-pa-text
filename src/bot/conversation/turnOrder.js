import { pickUniform } from '../../util/random.js';
import { pickWeighted } from '../../retrieval/personaWeights.js';

const MIN_PERSONAS = 2;

const sum = (counts) => [...counts.values()].reduce((total, n) => total + n, 0);

// Every persona speaks once; the rest go one at a time to a random persona still under the cap.
// The cap is the largest share that still allows no adjacent repeats.
const shareTurns = ({ personas, count, random }) => {
  const counts = new Map(personas.map((persona) => [persona, 1]));
  const cap = Math.ceil(count / 2);
  while (sum(counts) < count) {
    const open = personas.filter((persona) => counts.get(persona) < cap);
    const chosen = pickUniform(open, random());
    counts.set(chosen, counts.get(chosen) + 1);
  }
  return counts;
};

const entriesOf = (left, exclude) => [...left]
  .filter(([persona, turns]) => turns > 0 && persona !== exclude)
  .map(([persona, turns]) => ({ author: persona, weight: turns }));

// One random arrangement, or null when it ends with only the previous speaker left.
const arrangeOnce = ({ counts, count, random }) => {
  const left = new Map(counts);
  const order = [];
  for (let previous = null; order.length < count; previous = order.at(-1)) {
    const entries = entriesOf(left, previous);
    if (entries.length === 0) return null;
    const speaker = pickWeighted(entries, random());
    left.set(speaker, left.get(speaker) - 1);
    order.push(speaker);
  }
  return order;
};

// Most turns left first, never the previous speaker; ties go to the earlier persona.
export const interleave = (counts) => {
  const left = new Map(counts);
  const order = [];
  for (let previous = null; sum(left) > 0; previous = order.at(-1)) {
    const [best] = entriesOf(left, previous).sort((a, b) => b.weight - a.weight);
    if (!best) throw new Error('Cannot arrange the turns without a persona speaking twice in a row');
    left.set(best.author, left.get(best.author) - 1);
    order.push(best.author);
  }
  return order;
};

export const planTurns = ({ personas, count, random, attempts }) => {
  if (personas.length < MIN_PERSONAS) throw new Error('planTurns needs at least two personas');
  if (count < personas.length) throw new Error('planTurns needs a turn for every persona');
  const counts = shareTurns({ personas, count, random });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const order = arrangeOnce({ counts, count, random });
    if (order) return order;
  }
  return interleave(counts);
};
