import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from '../../../src/llm/prompts.js';

const fixture = fs.readFileSync(new URL('../../characterization/fixtures/system-prompt.txt', import.meta.url), 'utf8');

test('SYSTEM_PROMPT equals the fixture', () => {
  assert.equal(SYSTEM_PROMPT, fixture);
});

test('buildReplyPrompt equals a literal', () => {
  const out = buildReplyPrompt({
    author: 'alice', name: 'Alice Example', message: 'hi "there"', messageAuthor: 'alice', transcript: [],
    buckets: { replies: ['r1'], similar: ['c1', 'c2'], gifs: [], other: ['o1'] },
  });
  const expected = `The user you are emulating has username "alice", and their real name is "Alice Example".

The user has just received this message from "alice": "hi "there"".

Here are some examples of messages that the user has sent in response to messages that are similar in semantic meaning to the message they just received:
["r1"]

Here are some examples of some messages that the user has sent that are similar in semantic meaning to the message they just received:
["c1","c2"]

Here are some examples of responses to similar messages where the user's response included a GIF:
[]

Here are some examples of other messages that the user has sent that are not necessarily similar in semantic meaning to the message they just received, but are still representative of the user's general style and tone:
["o1"]`;
  assert.equal(out, expected);
});

test('buildRevivePrompt equals a literal', () => {
  const expected = `The user you are emulating has username "bob", and their real name is "Bob Example".

Here are some examples of messages that the user has sent in the past:
["m1","m2"]`;
  assert.equal(buildRevivePrompt({ author: 'bob', name: 'Bob Example', examples: ['m1', 'm2'] }), expected);
});

test('buildReplyPrompt serialises awkward bucket contents as JSON', () => {
  const buckets = { replies: ['a "q"', 'b\nc'], similar: [], gifs: ['<gif! x>'], other: ['é😀'] };
  const expected = `The user you are emulating has username "u", and their real name is "N".

The user has just received this message from "s": "m".

Here are some examples of messages that the user has sent in response to messages that are similar in semantic meaning to the message they just received:
["a \\"q\\"","b\\nc"]

Here are some examples of some messages that the user has sent that are similar in semantic meaning to the message they just received:
[]

Here are some examples of responses to similar messages where the user's response included a GIF:
["<gif! x>"]

Here are some examples of other messages that the user has sent that are not necessarily similar in semantic meaning to the message they just received, but are still representative of the user's general style and tone:
["é😀"]`;
  assert.equal(buildReplyPrompt({ author: 'u', name: 'N', message: 'm', messageAuthor: 's', buckets }), expected);
});

test('buildRevivePrompt renders an unknown name as the text undefined', () => {
  const expected = `The user you are emulating has username "u", and their real name is "undefined".

Here are some examples of messages that the user has sent in the past:
["x","y\\"z"]`;
  assert.equal(buildRevivePrompt({ author: 'u', name: undefined, examples: ['x', 'y"z'] }), expected);
});

test('buildReplyPrompt with a transcript equals the spec literal', () => {
  const T = Date.UTC(2026, 10, 12, 18, 1);
  const transcript = [
    { id: '1', speaker: 'alice', content: 'anyone around', timestamp: T, replyTo: null },
    { id: '2', speaker: 'carol', content: 'yeah whats up', timestamp: T + 60000, replyTo: 'alice' },
  ];
  const out = buildReplyPrompt({
    author: 'bob', name: 'Bob Example', message: 'want to get food', messageAuthor: 'alice', transcript,
    timeZone: 'America/Chicago', buckets: { replies: [], similar: [], gifs: [], other: [] },
  });
  const expectedHead = `The user you are emulating has username "bob", and their real name is "Bob Example".

Here is the recent conversation in the channel, oldest first, for context:
[12:01] alice: anyone around
[12:02] carol (replying to alice): yeah whats up

The user has just received this message from "alice": "want to get food".

Here are some examples of messages that the user has sent in response to messages that are similar in semantic meaning to the message they just received:
[]

`;
  assert.ok(out.startsWith(expectedHead), out);
  assert.equal(out.split('\n\n').length, 7);
});
