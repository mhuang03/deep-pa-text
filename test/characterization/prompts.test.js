import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorld } from '../support/world.js';

const newWorld = async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  return world;
};

test('SYSTEM_PROMPT equals the checked-in fixture', async (t) => {
  const world = await newWorld(t);
  const fixture = fs.readFileSync(new URL('./fixtures/system-prompt.txt', import.meta.url), 'utf8');
  assert.equal(world.subject.SYSTEM_PROMPT, fixture);
});

test('ragInput builds the exact legacy template with the four JSON sections in order', async (t) => {
  const world = await newWorld(t);
  const actual = world.subject.ragInput('alice', 'Alice Example', 'hi "there"', ['r1'], ['c1', 'c2'], [], ['o1'], {
    messageAuthor: 'alice',
  });
  const expected = [
    'The user you are emulating has username "alice", and their real name is "Alice Example".',
    '',
    'The user has just received this message from "alice": "hi "there"".',
    '',
    "Here are some examples of messages that the user has sent in response to messages that are similar in semantic meaning to the message they just received:",
    '["r1"]',
    '',
    "Here are some examples of some messages that the user has sent that are similar in semantic meaning to the message they just received:",
    '["c1","c2"]',
    '',
    "Here are some examples of responses to similar messages where the user's response included a GIF:",
    '[]',
    '',
    "Here are some examples of other messages that the user has sent that are not necessarily similar in semantic meaning to the message they just received, but are still representative of the user's general style and tone:",
    '["o1"]',
  ].join('\n');
  assert.equal(actual, expected);
});

test('contextlessInput builds the exact legacy template', async (t) => {
  const world = await newWorld(t);
  const actual = world.subject.contextlessInput('alice', 'Alice Example', ['m1', 'm2']);
  const expected = [
    'The user you are emulating has username "alice", and their real name is "Alice Example".',
    '',
    'Here are some examples of messages that the user has sent in the past:',
    '["m1","m2"]',
  ].join('\n');
  assert.equal(actual, expected);
});
