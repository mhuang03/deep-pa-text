import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listJs, specifiersOf, resolveSpecifier } from '../support/importGraph.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const ENTRY_POINT = path.join(ROOT, 'src/main.js');

// Files that some test file imports directly (by resolved path), not through another module.
const importedByTests = (testFiles) => {
  const covered = new Set();
  testFiles.forEach((file) => {
    specifiersOf(fs.readFileSync(file, 'utf8'))
      .map((specifier) => resolveSpecifier(file, specifier))
      .filter(Boolean)
      .forEach((target) => covered.add(target));
  });
  return covered;
};

test('every file under src except main.js is imported directly by a test', () => {
  const testFiles = listJs(path.join(ROOT, 'test')).filter((file) => file.endsWith('.test.js'));
  const covered = importedByTests(testFiles);
  const missing = listJs(path.join(ROOT, 'src'))
    .filter((file) => file !== ENTRY_POINT && !covered.has(file))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(missing, []);
});

test('a source file with no importing test is reported', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'coverage-'));
  const tested = path.join(dir, 'a.test.js');
  fs.writeFileSync(tested, 'import \'./covered.js\';\nimport { x } from "../elsewhere/other.js";\n');
  const covered = importedByTests([tested]);
  assert.equal(covered.has(path.join(dir, 'covered.js')), true);
  assert.equal(covered.has(path.join(dir, 'uncovered.js')), false);
  fs.rmSync(dir, { recursive: true });
});
