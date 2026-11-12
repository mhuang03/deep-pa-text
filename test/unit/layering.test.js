import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listJs, buildGraph, specifiersOf } from '../support/importGraph.js';
import { checkLayering, toRepoPath, unitOf } from '../support/layering.js';

const ROOT = new URL('../../', import.meta.url).pathname;

const sample = (file, ...imports) => ({
  file,
  imports: imports.map((target) => (target.startsWith('pkg:')
    ? { specifier: target.slice(4), target: null, external: true }
    : { specifier: target, target, external: false })),
});
const everything = () => true;

test('src and scripts respect the layer order, have no cycles and no stray discord.js imports', () => {
  const files = [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'scripts'))];
  const graph = buildGraph(files).map((node) => ({
    file: toRepoPath(ROOT, node.file),
    imports: node.imports.map((imp) => ({ ...imp, target: imp.target && toRepoPath(ROOT, imp.target) })),
  }));
  const exists = (target) => fs.existsSync(path.join(ROOT, target));
  assert.deepEqual(checkLayering(graph, exists), []);
});

test('reports an upward import', () => {
  const problems = checkLayering([sample('src/storage/a.js', 'src/bot/b.js')], everything);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /imports upward/);
});

test('reports an import between peer directories on the same level', () => {
  const problems = checkLayering([sample('src/llm/a.js', 'src/retrieval/b.js')], everything);
  assert.match(problems[0], /peer directory/);
  assert.deepEqual(checkLayering([sample('src/storage/a.js', 'src/discord/b.js')], everything).length, 1);
});

test('allows lower levels, the own directory, and imports inside levels 0 and 5', () => {
  const graph = [
    sample('src/bot/a.js', 'src/llm/b.js', 'src/bot/c.js', 'src/util/d.js'),
    sample('src/text/a.js', 'src/util/b.js'),
    sample('src/container/a.js', 'src/container.js', 'src/vendor.js'),
    sample('src/config/a.js', 'src/config.js'),
  ];
  assert.deepEqual(checkLayering(graph, everything), []);
});

test('reports an import cycle', () => {
  const graph = [sample('src/text/a.js', 'src/text/b.js'), sample('src/text/b.js', 'src/text/a.js')];
  assert.match(checkLayering(graph, everything).join('\n'), /import cycle: src\/text\/a\.js -> src\/text\/b\.js -> src\/text\/a\.js/);
});

test('reports a discord.js import outside the allowed directories', () => {
  assert.deepEqual(checkLayering([sample('src/llm/a.js', 'pkg:discord.js')], everything), ['src/llm/a.js imports discord.js']);
  assert.deepEqual(checkLayering([sample('src/bot/a.js', 'pkg:discord.js'), sample('scripts/x.js', 'pkg:discord.js')], everything), []);
});

test('reports a relative import that does not resolve', () => {
  const problems = checkLayering([sample('src/text/a.js', 'src/text/missing.js')], () => false);
  assert.match(problems[0], /does not resolve/);
});

test('a top-level file and its same-named directory are one unit', () => {
  assert.equal(unitOf('src/config.js'), 'config');
  assert.equal(unitOf('src/config/env.js'), 'config');
  assert.equal(unitOf('src/container/storage.js'), 'container');
  assert.equal(unitOf('scripts/backfill.js'), 'scripts');
});

test('the scanner finds static, re-export, side-effect and dynamic imports and ignores comments', () => {
  const text = [
    'import { a } from \'./a.js\';',
    'import b from "./b.js";',
    'import * as c from \'./c.js\';',
    'export { d } from \'./d.js\';',
    'import \'./side.js\';',
    'const e = await import(\'./e.js\');',
    '// import { x } from \'./commented.js\';',
    'const text = "not an import";',
  ].join('\n');
  assert.deepEqual(specifiersOf(text).sort(), ['./a.js', './b.js', './c.js', './d.js', './e.js', './side.js']);
});
