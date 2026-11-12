import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const DAY = 86_400_000;
const HELLO = 'hello there friends';
const ROLL_NEVER_REPLY_GATE = 0;
const MID_ROLL = 0.5;

const newWorld = async (t) => {
  const world = await createWorld({ random: [ROLL_NEVER_REPLY_GATE, MID_ROLL] });
  t.after(() => world.close());
  return world;
};

const personaOf = (message) => message.replies[0].embeds.at(-1).data.author.name;

test('a recent, near-identical reply beats an old, loosely similar one', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    { id: 'p1', author: 'dave', content: 'hello there zzz qqq', timestamp: BASE_TIME - 730 * DAY },
    { id: 'r1', author: 'bob', content: 'bob old reply', timestamp: BASE_TIME - 730 * DAY + 1000, reference: 'p1' },
    { id: 'p2', author: 'dave', content: HELLO, timestamp: BASE_TIME - DAY },
    { id: 'r2', author: 'carol', content: 'carol recent reply', timestamp: BASE_TIME - DAY + 1000, reference: 'p2' },
  ]);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(personaOf(message), 'carol');
});

test('recency alone decides between replies to identical parents', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    { id: 'p1', author: 'dave', content: HELLO, timestamp: BASE_TIME - 730 * DAY },
    { id: 'r1', author: 'bob', content: 'bob old reply', timestamp: BASE_TIME - 730 * DAY + 1000, reference: 'p1' },
    { id: 'p2', author: 'dave', content: HELLO, timestamp: BASE_TIME - DAY },
    { id: 'r2', author: 'carol', content: 'carol recent reply', timestamp: BASE_TIME - DAY + 1000, reference: 'p2' },
  ]);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(personaOf(message), 'carol');
});
