import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listJs } from '../support/importGraph.js';
import { findFunctions } from '../support/functionScan.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const MAX_FILE_LINES = 200;
const MAX_FUNCTION_LINES = 40;
const MAX_PARAMS = 3;

const files = [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'scripts'))];
const rel = (file) => path.relative(ROOT, file);

test('every file under src and scripts has at most 200 lines', () => {
  const offenders = files
    .map((file) => ({ file: rel(file), lines: fs.readFileSync(file, 'utf8').split('\n').length - 1 }))
    .filter(({ lines }) => lines > MAX_FILE_LINES);
  assert.deepEqual(offenders, []);
});

test('every function has at most 40 lines and 3 positional parameters', () => {
  const offenders = files.flatMap((file) => findFunctions(fs.readFileSync(file, 'utf8'))
    .filter((fn) => fn.lines > MAX_FUNCTION_LINES || fn.params > MAX_PARAMS)
    .map((fn) => `${rel(file)}:${fn.startLine} ${fn.kind} ${fn.lines} lines, ${fn.params} params`));
  assert.deepEqual(offenders, []);
});

const one = (text) => {
  const found = findFunctions(text);
  assert.equal(found.length, 1, JSON.stringify(found));
  return found[0];
};

test('scanner measures an arrow function with a block body', () => {
  const fn = one('const f = (a, b) => {\n  return a + b;\n};\n');
  assert.deepEqual([fn.startLine, fn.endLine, fn.lines, fn.params], [1, 3, 3, 2]);
});

test('scanner measures a function declaration and counts parameters', () => {
  const fn = one('function add(a, b, c, d) {\n  return a;\n}\n');
  assert.deepEqual([fn.lines, fn.params, fn.kind], [3, 4, 'function']);
});

test('scanner counts a destructured object or array parameter as one', () => {
  assert.equal(one('const f = ({ a, b, c, d }) => {\n  return a;\n};').params, 1);
  assert.equal(one('const f = ([a, b], { c }) => {\n  return a;\n};').params, 2);
  assert.equal(one('const f = (a, b = foo(1, 2)) => {\n  return a;\n};').params, 2);
});

test('scanner handles an expression-bodied arrow and a bare parameter', () => {
  const fn = one('const f = x =>\n  x + 1;\n');
  assert.deepEqual([fn.lines, fn.params], [2, 1]);
});

test('scanner finds nested arrows and async arrows', () => {
  const text = 'const outer = async (a) => {\n  const inner = async () => {\n    return 1;\n  };\n  return inner;\n};\n';
  const found = findFunctions(text);
  assert.deepEqual(found.map((fn) => fn.lines).sort(), [3, 6]);
});

test('scanner ignores braces in template literals, strings and comments', () => {
  const text = 'const f = () => {\n  const a = `{ ${ \'}\' } }`;\n  // } }\n  /* { */\n  return "}";\n};\n';
  assert.equal(one(text).lines, 6);
});

test('scanner handles nested template expressions', () => {
  const text = 'const f = () => {\n  return `a ${ g(`b ${ { x: 1 }.x } }`) } c`;\n};\n';
  assert.equal(one(text).lines, 3);
});

test('scanner ignores braces and quotes inside regular-expression literals', () => {
  const text = 'const f = (s) => {\n  const a = /[{"\']{2}/.test(s);\n  const b = s.replace(/\\}/g, \'\');\n  return a;\n};\n';
  assert.equal(one(text).lines, 5);
});

test('scanner finds object-method shorthand', () => {
  const text = 'const o = {\n  run(a) {\n    return a;\n  },\n  async stop() {\n    return 1;\n  },\n};\n';
  const found = findFunctions(text);
  assert.deepEqual(found.map((fn) => [fn.kind, fn.lines]), [['method', 3], ['method', 3]]);
});

test('scanner does not mistake control flow for methods', () => {
  const text = 'const f = (a) => {\n  if (a) {\n    return 1;\n  }\n  for (const x of a) {\n    return x;\n  }\n  try {\n    return 2;\n  } catch (e) {\n    return 3;\n  }\n};\n';
  assert.equal(one(text).lines, 13);
});
