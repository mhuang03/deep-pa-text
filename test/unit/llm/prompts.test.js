import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SYSTEM_PROMPT, REVIVE_SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from '../../../src/llm/prompts.js';

const fixture = fs.readFileSync(new URL('../../characterization/fixtures/system-prompt.txt', import.meta.url), 'utf8');

test('SYSTEM_PROMPT equals the fixture', () => {
  assert.equal(SYSTEM_PROMPT, fixture);
});

test('buildReplyPrompt equals a literal', () => {
  const out = buildReplyPrompt({
    author: 'alice', name: 'Alice Example', message: 'hi "there"', messageAuthor: 'alice', transcript: [],
    buckets: { replies: [{ you: 'r1', them: 'q1' }], similar: ['c1', 'c2'], gifs: [], other: ['o1'] },
  });
  const expected = `The user you are emulating has username "alice", and their real name is "Alice Example".

The user has just received this message from "alice": "hi "there"".

Here are examples of how the user replied to messages similar to the one they just received. "them" is the message the user was responding to and "you" is the user's reply:
[{"them":"q1","you":"r1"}]

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
  const buckets = { replies: [{ you: 'a "q"', them: null }, { you: 'b\nc', them: 'x' }], similar: [], gifs: ['<gif! x>'], other: ['é😀'] };
  const expected = `The user you are emulating has username "u", and their real name is "N".

The user has just received this message from "s": "m".

Here are examples of how the user replied to messages similar to the one they just received. "them" is the message the user was responding to and "you" is the user's reply:
[{"you":"a \\"q\\""},{"them":"x","you":"b\\nc"}]

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

Here are examples of how the user replied to messages similar to the one they just received. "them" is the message the user was responding to and "you" is the user's reply:
[]

`;
  assert.ok(out.startsWith(expectedHead), out);
  assert.equal(out.split('\n\n').length, 7);
});

test('frequent phrases follow the other examples and avoid-repeats comes last in both prompts', () => {
  const buckets = { replies: [], similar: ['s'], gifs: [], other: ['o'], frequent: [{ text: 'lol', times: 3 }] };
  const reply = buildReplyPrompt({
    author: 'a', name: 'A', message: 'm', messageAuthor: 'b', buckets, transcript: [], recentBotMessages: ['bot'],
  });
  const at = (text) => reply.indexOf(text);
  assert.ok(at('["o"]') < at('sends some of these messages often'));
  assert.ok(at('sends some of these messages often') < at('recently sent these messages'));
  assert.ok(reply.endsWith('["bot"]'));
  assert.ok(buildRevivePrompt({ author: 'a', name: 'A', examples: ['x'], recentBotMessages: ['bot'] }).endsWith('["bot"]'));
});

const FIRST = 'You are emulating a user on a Discord server. Your task is to respond to this message in a way that is consistent with how the user has responded to messages in the past.';
const REVIVE_FIRST = 'You are emulating a user on a Discord server. The channel has gone quiet. Your task is to write the next message this user would send to get conversation going again, in a way that is consistent with how the user has written in the past. It can follow up on the last conversation or bring up something new, as that user would.';
const GIF = 'based on the content of the message they received, and based on the search terms that the user has used in the past when responding to similar messages';
const REVIVE_GIF = 'based on what you are saying and on the search terms that the user has used in the past';

test('REVIVE_SYSTEM_PROMPT differs from SYSTEM_PROMPT only in the two stated places', () => {
  assert.notEqual(REVIVE_SYSTEM_PROMPT, SYSTEM_PROMPT);
  const restored = REVIVE_SYSTEM_PROMPT.replace(REVIVE_FIRST, FIRST).replace(REVIVE_GIF, GIF);
  assert.equal(restored, SYSTEM_PROMPT);
  assert.ok(REVIVE_SYSTEM_PROMPT.includes(REVIVE_FIRST) && REVIVE_SYSTEM_PROMPT.includes(REVIVE_GIF));
});

test('buildRevivePrompt with every section follows the spec order', () => {
  const T = Date.UTC(2026, 10, 12, 21, 10);
  const out = buildRevivePrompt({
    author: 'bob', name: 'Bob Example', examples: ['e1'], starters: ['s1'],
    transcript: [{ id: '1', speaker: 'alice', content: 'hi', timestamp: T - 3600000, replyTo: null }],
    quietMs: 3600000, nowMs: T, timeZone: 'America/Chicago', recentBotMessages: ['bot'],
  });
  assert.equal(out, `The user you are emulating has username "bob", and their real name is "Bob Example".

It is Thursday 3:10 PM. The channel has been quiet for about 1 hour.

Here is the end of the last conversation in the channel, oldest first:
[14:10] alice: hi

Here are messages this user has sent to start a conversation after the channel had been quiet:
["s1"]

Here are some examples of messages that the user has sent in the past:
["e1"]

The bot you are part of recently sent these messages in the channel. Do not repeat them or reuse their distinctive phrasing:
["bot"]`);
});

test('buildRevivePrompt keeps the time sentence without a quiet duration and omits empty sections', () => {
  const out = buildRevivePrompt({
    author: 'b', name: 'B', examples: ['e'], starters: [], transcript: [], nowMs: Date.UTC(2026, 10, 12, 21, 10),
    timeZone: 'America/Chicago',
  });
  assert.equal(out.split('\n\n')[1], 'It is Thursday 3:10 PM.');
  assert.ok(!out.includes('last conversation') && !out.includes('start a conversation'));
});
