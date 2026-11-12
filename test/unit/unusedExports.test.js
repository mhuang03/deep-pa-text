import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listJs } from '../support/importGraph.js';
import { exportsOf, importedNames, collectUsage, unusedExports } from '../support/moduleExports.js';

const ROOT = new URL('../../', import.meta.url).pathname;

test('every named export under src is imported in src, scripts or test', () => {
  const srcFiles = listJs(path.join(ROOT, 'src'));
  const everything = [...srcFiles, ...listJs(path.join(ROOT, 'scripts')), ...listJs(path.join(ROOT, 'test'))];
  const unused = unusedExports(srcFiles, collectUsage(everything)).map((entry) => {
    const [file, name] = entry.split(': ');
    return `${file}: ${name}`;
  });
  assert.deepEqual(unused, []);
});

test('finds exported declarations and export lists', () => {
  const text = 'export const a = 1;\nexport const b = () => {};\nexport function c() {}\nconst d = 1;\nexport { d, d as e };\n';
  assert.deepEqual(exportsOf(text), ['a', 'b', 'c', 'd', 'e']);
});

test('ignores exports inside comments and strings', () => {
  assert.deepEqual(exportsOf('// export const x = 1;\nconst s = "export const y = 2";\n'), []);
});

test('collects named, aliased, namespace and re-exported imports by resolved path', () => {
  const from = path.join(ROOT, 'test/x.test.js');
  const text = [
    'import { a, b as c } from \'../src/one.js\';',
    'import * as two from \'../src/two.js\';',
    'export { d } from \'../src/three.js\';',
    'import { z } from \'node:path\';',
  ].join('\n');
  const used = importedNames(from, text);
  assert.deepEqual([...used.get(path.join(ROOT, 'src/one.js'))], ['a', 'b']);
  assert.deepEqual([...used.get(path.join(ROOT, 'src/two.js'))], ['*']);
  assert.deepEqual([...used.get(path.join(ROOT, 'src/three.js'))], ['d']);
  assert.equal(used.size, 3);
});
