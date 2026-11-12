import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postProcess } from '../../../src/llm/postProcess.js';

const burst = { maxMessages: 3, enabled: true };
const MAX_GIFS = 2;
const run = (raw, options = {}) => postProcess(raw, { burst, maxGifsPerMessage: MAX_GIFS, ...options });

test('splits before sanitising so each quoted part is unwrapped', () => {
  assert.deepEqual(run('"one"\n<split>\n"two"', {}), {
    response: 'one\n<split>\ntwo', parts: ['one', 'two'],
  });
});

test('a plain response is a single part', () => {
  assert.deepEqual(run('  hello ', {}), { response: 'hello', parts: ['hello'] });
});

test('parts that are empty after sanitising are dropped', () => {
  assert.deepEqual(run('one<split>""<split>two', {}).parts, ['one', 'two']);
});

test('throws when nothing is left', () => {
  assert.throws(() => run('  '), /LLM returned an empty response/);
  assert.throws(() => run('<split>""', {}), /LLM returned an empty response/);
});

test('with bursts disabled the marker becomes a newline in one part', () => {
  assert.deepEqual(run('a<split>b', { burst: { ...burst, enabled: false } }), {
    response: 'a\nb', parts: ['a\nb'],
  });
});

test('the empty-output error is marked so the generator can retry it', () => {
  assert.throws(() => run('""', {}), (error) => error.isEmptyOutput === true);
});

const partsOf = (raw, options) => run(raw, options).parts;

test('a masked link keeps its text, bare links and invites are removed', () => {
  assert.deepEqual(partsOf('check [free nitro](http://phish.example) now'), ['check free nitro now']);
  assert.deepEqual(partsOf('join discord.gg/abc now'), ['join  now']);
});

test('a part that was only a link is dropped, and a response of only a link counts as empty', () => {
  assert.deepEqual(partsOf('hello<split>https://example.com'), ['hello']);
  assert.throws(() => run('https://example.com'), (error) => error.isEmptyOutput === true);
});

test('a whole answer wrapped in one pair of quotes is unwrapped once before splitting', () => {
  assert.deepEqual(partsOf('"a <split> b"'), ['a', 'b']);
});

test('"yes" or "no" is left alone and "hello" is unwrapped', () => {
  assert.deepEqual(partsOf('"yes" or "no"'), ['"yes" or "no"']);
  assert.deepEqual(partsOf('"hello"'), ['hello']);
});

test('over-cap parts are cleaned before they are merged: no stray quotes', () => {
  assert.deepEqual(partsOf('"a"\n<split>\n"b"\n<split>\n"c"\n<split>\n"d"'), ['a', 'b', 'c\nd']);
});

test('dangling quotes left by a split are removed, with or without bursts', () => {
  assert.deepEqual(partsOf('"a <split> b" <split> "c"'), ['a', 'b', 'c']);
  assert.deepEqual(partsOf('"a <split> b"', { burst: { ...burst, enabled: false } }), ['a\nb']);
  assert.deepEqual(partsOf('"unterminated', { burst: { ...burst, enabled: false } }), ['unterminated']);
});

test('the GIF cap applies to each final part, after overflow parts were merged', () => {
  const tokens = '<gif! 1> <gif! 2> <gif! 3> <gif! 4> <gif! 5>';
  assert.deepEqual(partsOf(`x ${tokens}`), ['x <gif! 1> <gif! 2>']);
  const merged = partsOf('a<split>b<split>c <gif! 1><split>d <gif! 2> <gif! 3>');
  assert.equal(merged.length, 3);
  assert.equal((merged[2].match(/<gif!/g) ?? []).length, 2);
});

test('a part left empty by the GIF cap is dropped', () => {
  assert.deepEqual(partsOf('a<split><gif! x>', { maxGifsPerMessage: 0 }), ['a']);
});
