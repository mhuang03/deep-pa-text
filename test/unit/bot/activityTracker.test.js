import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker } from '../../../src/bot/activityTracker.js';

const createClock = (start) => {
  let time = start;
  return { now: () => time, set: (value) => (time = value) };
};

test('starts at the current time with the bot as last author', () => {
  const clock = createClock(1000);
  const tracker = createActivityTracker({ now: clock.now });
  assert.deepEqual(tracker.get(), { lastMessageTime: 1000, lastWasBot: true });
});

test('noteHuman records the message timestamp, not the current time', () => {
  const clock = createClock(1000);
  const tracker = createActivityTracker({ now: clock.now });
  tracker.noteHuman({ timestamp: 400, author: 'alice' });
  assert.deepEqual(tracker.get(), { lastMessageTime: 400, lastWasBot: false });
});

test('noteBot records the current time and marks the bot as last author', () => {
  const clock = createClock(1000);
  const tracker = createActivityTracker({ now: clock.now });
  tracker.noteHuman({ timestamp: 400, author: 'alice' });
  clock.set(2500);
  tracker.noteBot();
  assert.deepEqual(tracker.get(), { lastMessageTime: 2500, lastWasBot: true });
});

test('get returns a snapshot that later changes do not alter', () => {
  const tracker = createActivityTracker({ now: () => 1 });
  const before = tracker.get();
  tracker.noteHuman({ timestamp: 9, author: 'a' });
  assert.deepEqual(before, { lastMessageTime: 1, lastWasBot: true });
});

test('instances do not share state', () => {
  const a = createActivityTracker({ now: () => 1 });
  const b = createActivityTracker({ now: () => 1 });
  a.noteHuman({ timestamp: 5, author: 'x' });
  assert.equal(b.get().lastWasBot, true);
});
