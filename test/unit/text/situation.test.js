import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeLocalTime, describeQuiet } from '../../../src/text/situation.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const ZONE = 'America/Chicago';

test('describeLocalTime names the weekday and 12-hour time in winter', () => {
  assert.equal(describeLocalTime(Date.UTC(2026, 10, 12, 21, 10), ZONE), 'Thursday 3:10 PM');
});

test('describeLocalTime uses daylight time in summer', () => {
  assert.equal(describeLocalTime(Date.UTC(2026, 6, 9, 20, 10), ZONE), 'Thursday 3:10 PM');
});

test('describeLocalTime at local midnight', () => {
  assert.equal(describeLocalTime(Date.UTC(2026, 10, 13, 6, 5), ZONE), 'Friday 12:05 AM');
});

const CASES = [
  [null, null],
  [59 * MINUTE, 'less than an hour'],
  [60 * MINUTE, 'about 1 hour'],
  [90 * MINUTE, 'about 2 hours'],
  [3 * HOUR + 20 * MINUTE, 'about 3 hours'],
  [47 * HOUR + 40 * MINUTE, 'about 48 hours'],
  [48 * HOUR, 'about 2 days'],
  [71 * HOUR, 'about 3 days'],
  [-5 * MINUTE, 'less than an hour'],
  [0, 'less than an hour'],
];

CASES.forEach(([ms, expected]) => {
  test(`describeQuiet(${ms}) is ${expected}`, () => {
    assert.equal(describeQuiet(ms), expected);
  });
});
