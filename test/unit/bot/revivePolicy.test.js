import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDaytime, shouldRevive } from '../../../src/bot/revivePolicy.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});
const overrideConfig = loadConfig({ REVIVE_OVERRIDE: 'true' });
const HOUR = 3600000;

// Chicago is UTC-6 in winter (CST) and UTC-5 in summer (CDT).
const centralMs = (date, hour, offset) => Date.parse(`${date}T00:00:00Z`) + (hour + offset) * HOUR;

const SEASONS = [['standard time', '2026-11-12', 6], ['daylight time', '2026-07-01', 5]];

SEASONS.forEach(([label, date, offset]) => {
  [[9, false], [10, true], [22, true], [23, false], [0, false]].forEach(([hour, expected]) => {
    test(`isDaytime is ${expected} at hour ${hour} in ${label}`, () => {
      assert.equal(isDaytime(centralMs(date, hour, offset), config), expected);
    });
  });
});

test('isDaytime uses the configured hour window and time zone', () => {
  const custom = { revive: { ...config.revive, timeZone: 'UTC', dayStartHour: 1, dayEndHour: 2 } };
  const at = (hour) => Date.parse('2026-11-12T00:00:00Z') + hour * HOUR;
  assert.deepEqual([0, 1, 2, 3].map((h) => isDaytime(at(h), custom)), [false, true, true, false]);
});

const NOON = centralMs('2026-11-12', 12, 6);
const MIDNIGHT = centralMs('2026-11-12', 0, 6);

const CASES = [
  ['day', NOON, 3 * HOUR],
  ['night', MIDNIGHT, 12 * HOUR],
];

CASES.forEach(([period, nowMs, threshold]) => {
  [[-1, false], [0, false], [1, true]].forEach(([delta, human]) => {
    test(`human last, ${period}, threshold ${delta < 0 ? 'below' : delta === 0 ? 'at' : 'above'}: ${human}`, () => {
      const activity = { lastWasBot: false, lastMessageTime: nowMs - (threshold + delta) };
      assert.equal(shouldRevive({ activity, nowMs, config }), human);
    });

    test(`bot last, ${period}, threshold delta ${delta}: never revives`, () => {
      const activity = { lastWasBot: true, lastMessageTime: nowMs - (threshold + delta) };
      assert.equal(shouldRevive({ activity, nowMs, config }), false);
    });
  });

  test(`override revives in ${period} regardless of activity`, () => {
    const botLast = { lastWasBot: true, lastMessageTime: nowMs };
    const humanRecent = { lastWasBot: false, lastMessageTime: nowMs };
    assert.equal(shouldRevive({ activity: botLast, nowMs, config: overrideConfig }), true);
    assert.equal(shouldRevive({ activity: humanRecent, nowMs, config: overrideConfig }), true);
  });
});

test('a night gap that would exceed the day threshold does not revive at night', () => {
  const activity = { lastWasBot: false, lastMessageTime: MIDNIGHT - 5 * HOUR };
  assert.equal(shouldRevive({ activity, nowMs: MIDNIGHT, config }), false);
});
