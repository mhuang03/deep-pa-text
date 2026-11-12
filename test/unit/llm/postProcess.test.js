import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postProcess } from '../../../src/llm/postProcess.js';

const burst = { maxMessages: 3, enabled: true };

test('splits before sanitising so each quoted part is unwrapped', () => {
  assert.deepEqual(postProcess('"one"\n<split>\n"two"', { burst }), {
    response: 'one\n<split>\ntwo', parts: ['one', 'two'],
  });
});

test('a plain response is a single part', () => {
  assert.deepEqual(postProcess('  hello ', { burst }), { response: 'hello', parts: ['hello'] });
});

test('parts that are empty after sanitising are dropped', () => {
  assert.deepEqual(postProcess('one<split>""<split>two', { burst }).parts, ['one', 'two']);
});

test('throws when nothing is left', () => {
  assert.throws(() => postProcess('  ', { burst }), /LLM returned an empty response/);
  assert.throws(() => postProcess('<split>""', { burst }), /LLM returned an empty response/);
});

test('with bursts disabled the marker becomes a newline in one part', () => {
  assert.deepEqual(postProcess('a<split>b', { burst: { ...burst, enabled: false } }), {
    response: 'a\nb', parts: ['a\nb'],
  });
});
