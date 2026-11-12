// Layer rules for src/ and scripts/ (see CLAUDE.md). Works on plain data so it can be self-tested.
import path from 'node:path';

export const LEVELS = {
  main: 5, container: 5, vendor: 5, scripts: 5,
  backfill: 4,
  bot: 3,
  ingest: 2, retrieval: 2, context: 2, profiles: 2, llm: 2, gifs: 2,
  storage: 1, discord: 1,
  corpus: 0, text: 0, util: 0, config: 0, logger: 0, userData: 0,
};
export const DISCORD_JS_ALLOWED = ['discord', 'bot', 'backfill', 'vendor', 'scripts'];

// A top-level file and the directory with the same stem are one unit (config.js and config/).
export const unitOf = (file) => {
  const parts = file.split('/');
  if (parts[0] === 'scripts') return 'scripts';
  const first = parts[1];
  return first.endsWith('.js') ? first.slice(0, -3) : first;
};

const edgeProblem = (from, to) => {
  const a = unitOf(from);
  const b = unitOf(to);
  if (a === b) return null;
  const [la, lb] = [LEVELS[a], LEVELS[b]];
  if (la === undefined) return `${from} is in an unknown layer`;
  if (lb === undefined) return `${to} is in an unknown layer`;
  if (lb > la) return `${from} (level ${la}) imports upward: ${to} (level ${lb})`;
  if (lb === la && la !== 0 && la !== 5) return `${from} imports a peer directory: ${to}`;
  return null;
};

const findCycle = (adjacency) => {
  const state = new Map();
  const visit = (node, trail) => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'active') return [...trail.slice(trail.indexOf(node)), node];
    state.set(node, 'active');
    for (const next of adjacency.get(node) ?? []) {
      const found = visit(next, [...trail, node]);
      if (found) return found;
    }
    state.set(node, 'done');
    return null;
  };
  for (const node of adjacency.keys()) {
    const found = visit(node, []);
    if (found) return found;
  }
  return null;
};

// graph: [{ file, imports: [{ specifier, target, external }] }] with files and targets relative to the repo root.
export const checkLayering = (graph, exists) => {
  const problems = [];
  const adjacency = new Map();
  for (const { file, imports } of graph) {
    adjacency.set(file, []);
    for (const imp of imports) {
      if (imp.external) {
        const bare = imp.specifier.split('/')[0];
        if (bare === 'discord.js' && !DISCORD_JS_ALLOWED.includes(unitOf(file))) problems.push(`${file} imports discord.js`);
        continue;
      }
      if (!exists(imp.target)) {
        problems.push(`${file} imports ${imp.specifier}, which does not resolve`);
        continue;
      }
      adjacency.get(file).push(imp.target);
      const problem = edgeProblem(file, imp.target);
      if (problem) problems.push(problem);
    }
  }
  const cycle = findCycle(adjacency);
  if (cycle) problems.push(`import cycle: ${cycle.join(' -> ')}`);
  return problems;
};

export const toRepoPath = (root, absolute) => path.relative(root, absolute).split(path.sep).join('/');
