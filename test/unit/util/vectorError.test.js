import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markVectorError } from '../../../src/util/vectorError.js';

test('returns a new tagged error with the same message and the original as cause', () => {
  const original = new Error('chroma down');
  const tagged = markVectorError(original);
  assert.notEqual(tagged, original);
  assert.equal(tagged.message, 'chroma down');
  assert.equal(tagged.cause, original);
  assert.equal(tagged.isVectorError, true);
  assert.equal(original.isVectorError, undefined);
});

test('an already tagged error passes through unchanged', () => {
  const tagged = markVectorError(new Error('x'));
  assert.equal(markVectorError(tagged), tagged);
});

test('a thrown non-error value is wrapped with its text as the message', () => {
  const tagged = markVectorError('plain text');
  assert.equal(tagged.message, 'plain text');
  assert.equal(tagged.isVectorError, true);
});
