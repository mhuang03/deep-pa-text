import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, pickUniform } from '../../../src/util/random.js';

test('randomInt maps a roll onto the inclusive range', () => {
  assert.equal(randomInt(() => 0, 2, 5), 2);
  assert.equal(randomInt(() => 0.25, 2, 5), 3);
  assert.equal(randomInt(() => 0.5, 2, 5), 4);
  assert.equal(randomInt(() => 0.999999, 2, 5), 5);
});

test('randomInt with equal bounds always returns that value and still draws once', () => {
  let calls = 0;
  assert.equal(randomInt(() => { calls += 1; return 0.7; }, 4, 4), 4);
  assert.equal(calls, 1);
});

test('pickUniform picks list[floor(roll * length)]', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.equal(pickUniform(list, 0), 'a');
  assert.equal(pickUniform(list, 0.49), 'b');
  assert.equal(pickUniform(list, 0.5), 'c');
  assert.equal(pickUniform(list, 0.99), 'd');
});

test('pickUniform stays inside the list for a roll of exactly 1', () => {
  assert.equal(pickUniform(['a', 'b'], 1), 'b');
});
