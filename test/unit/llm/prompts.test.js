import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from '../../../src/llm/prompts.js';
import { ragInput, contextlessInput, SYSTEM_PROMPT as LEGACY_SYSTEM } from '../../../prompt.js';

const fixture = fs.readFileSync(new URL('../../characterization/fixtures/system-prompt.txt', import.meta.url), 'utf8');

test('SYSTEM_PROMPT equals the fixture and the legacy prompt', () => {
  assert.equal(SYSTEM_PROMPT, fixture);
  assert.equal(SYSTEM_PROMPT, LEGACY_SYSTEM);
});

test('buildReplyPrompt equals a literal', () => {
  const out = buildReplyPrompt({
    author: 'alice', name: 'Alice Example', message: 'hi "there"',
    buckets: { replies: ['r1'], similar: ['c1', 'c2'], gifs: [], other: ['o1'] },
  });
  const expected = `The user you are emulating has username "alice", and their real name is "Alice Example".
The user has just received the message: "hi "there"".

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

test('matches the legacy builders for sample inputs', () => {
  const buckets = { replies: ['a "q"', 'b\nc'], similar: [], gifs: ['<gif! x>'], other: ['é😀'] };
  assert.equal(
    buildReplyPrompt({ author: 'u', name: 'N', message: 'm', buckets }),
    ragInput('u', 'N', 'm', buckets.replies, buckets.similar, buckets.gifs, buckets.other),
  );
  assert.equal(
    buildRevivePrompt({ author: 'u', name: undefined, examples: ['x', 'y"z'] }),
    contextlessInput('u', undefined, ['x', 'y"z']),
  );
});
