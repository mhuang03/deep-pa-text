import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';

const HELLO = 'hello there friends';
const MAX_LENGTH = 2000;

const newWorld = async (t) => {
  const world = await createWorld({ random: 0 });
  t.after(() => world.close());
  return world;
};

test('a quoted response is delivered unquoted', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('"nice one"');
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(message.replies[0].content, 'nice one');
});

test('an empty completion followed by a valid one yields one reply from two calls', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith(['', 'second wind']);
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(message.replies[0].content, 'second wind');
  assert.equal(world.llm.calls.length, 2);
});

test('all-empty completions send nothing and later messages still work', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith([null, { choices: [] }]);
  const first = await world.emitMessage({ content: HELLO });
  assert.equal(first.replies.length, 0);
  assert.equal(world.llm.calls.length, 2);
  const failures = world.logs.error.filter(([first]) => /Error processing message/.test(String(first)));
  assert.equal(failures.length, 1);
  assert.match(String(failures[0][0]), /stage generation/);
  assert.match(failures[0].map(String).join(' '), /LLM returned an empty response/);
  world.llm.respondWith('back again');
  await world.advance(300_000);
  const second = await world.emitMessage({ content: HELLO });
  assert.equal(second.replies[0].content, 'back again');
});

test('an over-long response is delivered truncated to the Discord limit', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('a'.repeat(MAX_LENGTH + 500));
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(message.replies[0].content.length, MAX_LENGTH);
});
