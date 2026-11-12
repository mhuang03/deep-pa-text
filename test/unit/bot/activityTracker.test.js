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

test('restore sets the state when nothing live has happened yet', () => {
  const tracker = createActivityTracker({ now: () => 1000 });
  tracker.restore({ lastMessageTime: 100, lastWasBot: false });
  assert.deepEqual(tracker.get(), { lastMessageTime: 100, lastWasBot: false });
});

test('restore never moves the clock backwards once a live handler has spoken', () => {
  const tracker = createActivityTracker({ now: () => 1000 });
  tracker.noteHuman({ timestamp: 500 });
  tracker.restore({ lastMessageTime: 100, lastWasBot: true });
  assert.deepEqual(tracker.get(), { lastMessageTime: 500, lastWasBot: false });
  tracker.restore({ lastMessageTime: 800, lastWasBot: true });
  assert.deepEqual(tracker.get(), { lastMessageTime: 800, lastWasBot: true });
});

test('noteBot returns an undo that restores the state from before it', () => {
  const clock = createClock(1000);
  const tracker = createActivityTracker({ now: clock.now });
  tracker.noteHuman({ timestamp: 400, author: 'alice' });
  clock.set(2500);
  const undo = tracker.noteBot();
  assert.deepEqual(tracker.get(), { lastMessageTime: 2500, lastWasBot: true });
  undo();
  assert.deepEqual(tracker.get(), { lastMessageTime: 400, lastWasBot: false });
});

test('undo does nothing once a human message arrived in the meantime', () => {
  const tracker = createActivityTracker({ now: () => 2500 });
  tracker.noteHuman({ timestamp: 400, author: 'alice' });
  const undo = tracker.noteBot();
  tracker.noteHuman({ timestamp: 2000, author: 'bob' });
  undo();
  assert.deepEqual(tracker.get(), { lastMessageTime: 2000, lastWasBot: false });
});

test('undo does nothing after a later noteBot, and a stale undo cannot be replayed over newer state', () => {
  const clock = createClock(1000);
  const tracker = createActivityTracker({ now: clock.now });
  tracker.noteHuman({ timestamp: 400, author: 'alice' });
  const first = tracker.noteBot();
  clock.set(3000);
  tracker.noteBot();
  first();
  assert.deepEqual(tracker.get(), { lastMessageTime: 3000, lastWasBot: true });
});

test('undo applies once: a second call changes nothing', () => {
  const tracker = createActivityTracker({ now: () => 2500 });
  tracker.noteHuman({ timestamp: 400, author: 'alice' });
  const undo = tracker.noteBot();
  undo();
  tracker.noteHuman({ timestamp: 900, author: 'bob' });
  undo();
  assert.deepEqual(tracker.get(), { lastMessageTime: 900, lastWasBot: false });
});

test('undo after a restore does nothing, and an undone initial state is still restorable', () => {
  const tracker = createActivityTracker({ now: () => 1000 });
  const undo = tracker.noteBot();
  undo();
  tracker.restore({ lastMessageTime: 100, lastWasBot: false });
  assert.deepEqual(tracker.get(), { lastMessageTime: 100, lastWasBot: false });
});
