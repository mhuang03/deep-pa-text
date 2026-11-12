import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sections from '../../../src/llm/promptSections.js';

const entries = [{ id: '1', speaker: 'alice', content: 'hey', timestamp: Date.UTC(2026, 0, 1, 12, 1), replyTo: null }];
const buckets = { replies: [{ you: 'r', them: 'q' }], similar: ['s'], gifs: [], other: ['o"'] };

test('identity names the username and real name', () => {
  assert.equal(
    sections.identity({ author: 'bob', name: 'Bob Example' }),
    'The user you are emulating has username "bob", and their real name is "Bob Example".',
  );
});

test('transcript is omitted when empty or missing', () => {
  assert.equal(sections.transcript({ transcript: [], timeZone: 'UTC' }), null);
  assert.equal(sections.transcript({ timeZone: 'UTC' }), null);
});

test('transcript introduces and formats the entries', () => {
  assert.equal(
    sections.transcript({ transcript: entries, timeZone: 'UTC' }),
    'Here is the recent conversation in the channel, oldest first, for context:\n[12:01] alice: hey',
  );
});

test('target names the sender', () => {
  assert.equal(
    sections.target({ message: 'hi', messageAuthor: 'alice' }),
    'The user has just received this message from "alice": "hi".',
  );
});

test('each example section is the intro, a newline and the JSON bucket', () => {
  const cases = [
    [sections.replyExamples, 'how the user replied to messages similar', '[{"them":"q","you":"r"}]'],
    [sections.similarExamples, 'some messages that the user has sent that are similar', '["s"]'],
    [sections.gifExamples, 'included a GIF', '[]'],
    [sections.otherExamples, 'not necessarily similar', '["o\\""]'],
  ];
  cases.forEach(([section, intro, json]) => {
    const text = section({ buckets });
    assert.ok(text.includes(intro), intro);
    assert.ok(text.endsWith(`:\n${json}`), text);
  });
});

test('pastExamples lists the revive examples', () => {
  assert.equal(
    sections.pastExamples({ examples: ['a'] }),
    'Here are some examples of messages that the user has sent in the past:\n["a"]',
  );
});

test('assemble omits null sections and joins the rest with a blank line', () => {
  const out = sections.assemble([() => 'a', () => null, (ctx) => ctx.x], { x: 'b' });
  assert.equal(out, 'a\n\nb');
});

test('reply examples put them first, omit a null them, and cut long them', () => {
  const text = sections.replyExamples({
    maxEntryChars: 5,
    buckets: { replies: [{ you: 'a', them: 'abcdefgh' }, { you: 'b', them: null }] },
  });
  assert.ok(text.endsWith(':\n[{"them":"abcde…","you":"a"},{"you":"b"}]'), text);
});
