import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integer, atLeast, above, between, checkRules } from '../../../src/config/rules.js';

test('integer checks whole numbers inside the bounds', () => {
  const rule = integer(1, 5);
  assert.deepEqual([0, 1, 5, 6, 2.5, NaN].map(rule.test), [false, true, true, false, false, false]);
  assert.equal(rule.text, 'an integer from 1 to 5');
  assert.equal(integer(2).text, 'an integer of at least 2');
  assert.equal(integer(2).test(Infinity), false);
});

test('atLeast includes the bound and above excludes it', () => {
  assert.deepEqual([-1, 0, 1].map(atLeast(0).test), [false, true, true]);
  assert.deepEqual([-1, 0, 1].map(above(0).test), [false, false, true]);
  assert.equal(atLeast(0).test(Infinity), false);
});

test('between honours which ends are open', () => {
  assert.deepEqual([0, 0.5, 1].map(between(0, 1).test), [true, true, true]);
  assert.deepEqual([0, 0.5, 1].map(between(0, 1, 'low').test), [false, true, true]);
  assert.deepEqual([0, 0.5, 1].map(between(0, 1, 'high').test), [true, true, false]);
  assert.deepEqual([0, 0.5, 1].map(between(0, 1, 'both').test), [false, true, false]);
  assert.equal(between(0, 1, 'low').text, 'a number in (0, 1]');
});

test('checkRules returns the section or names the first bad key', () => {
  const section = { a: 1, b: 0 };
  assert.equal(checkRules('s', section, { a: integer(1) }), section);
  assert.throws(() => checkRules('s', section, { a: integer(1), b: integer(1) }), /s\.b must be an integer of at least 1/);
});
