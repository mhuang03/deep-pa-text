import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagFailure, DELIVERY_STAGE, GENERATION_STAGE } from '../../../src/bot/responderFailure.js';

test('wraps an error with its stage, persona and trigger and keeps the cause', () => {
  const original = new Error('send failed');
  const tagged = tagFailure(original, { stage: DELIVERY_STAGE, persona: 'bob', trigger: 'auto' });
  assert.notEqual(tagged, original);
  assert.equal(tagged.message, 'send failed');
  assert.equal(tagged.cause, original);
  assert.deepEqual([tagged.stage, tagged.persona, tagged.trigger], ['delivery', 'bob', 'auto']);
});

test('never mutates the error it was given', () => {
  const original = new Error('x');
  tagFailure(original, { stage: GENERATION_STAGE, persona: 'p', trigger: 't' });
  assert.equal('stage' in original, false);
  assert.equal('persona' in original, false);
});

test('accepts a thrown non-error value', () => {
  const tagged = tagFailure('plain string', { stage: GENERATION_STAGE, persona: 'p', trigger: 't' });
  assert.equal(tagged.message, 'plain string');
  assert.equal(tagged.cause, 'plain string');
});
