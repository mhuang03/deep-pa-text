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

test('frequentPhrases is omitted when empty or missing and otherwise lists the JSON', () => {
  assert.equal(sections.frequentPhrases({ buckets: { frequent: [] } }), null);
  assert.equal(sections.frequentPhrases({ buckets: {} }), null);
  assert.equal(
    sections.frequentPhrases({ buckets: { frequent: [{ text: 'lol', times: 6 }] } }),
    'The user sends some of these messages often. Number of times they have sent each (use them only where they fit):\n[{"text":"lol","times":6}]',
  );
});

test('avoidRepeats is omitted when empty or missing and otherwise lists the JSON', () => {
  assert.equal(sections.avoidRepeats({ recentBotMessages: [] }), null);
  assert.equal(sections.avoidRepeats({}), null);
  assert.equal(
    sections.avoidRepeats({ recentBotMessages: ['hi', 'yo "x"'] }),
    'The bot you are part of recently sent these messages in the channel. Do not repeat them or reuse their distinctive phrasing:\n["hi","yo \\"x\\""]',
  );
});

const NOW = Date.UTC(2026, 10, 12, 21, 10);

test('situation names the local time and the quiet duration, omitted without a finite nowMs', () => {
  assert.equal(sections.situation({ nowMs: NOW, quietMs: 5400000, timeZone: 'America/Chicago' }),
    'It is Thursday 3:10 PM. The channel has been quiet for about 2 hours.');
  assert.equal(sections.situation({ nowMs: NOW, timeZone: 'America/Chicago' }), 'It is Thursday 3:10 PM.');
  assert.equal(sections.situation({ quietMs: 5 }), null);
  assert.equal(sections.situation({ nowMs: NaN }), null);
});

test('lastConversation renders the transcript and is omitted when empty', () => {
  const transcript = [{ id: '1', speaker: 'alice', content: 'hi', timestamp: NOW, replyTo: null }];
  assert.equal(sections.lastConversation({ transcript, timeZone: 'America/Chicago' }),
    'Here is the end of the last conversation in the channel, oldest first:\n[15:10] alice: hi');
  assert.equal(sections.lastConversation({ transcript: [] }), null);
  assert.equal(sections.lastConversation({}), null);
});

test('starters renders JSON and is omitted when empty', () => {
  assert.equal(sections.starters({ starters: ['yo', 'hey'] }),
    'Here are messages this user has sent to start a conversation after the channel had been quiet:\n["yo","hey"]');
  assert.equal(sections.starters({ starters: [] }), null);
  assert.equal(sections.starters({}), null);
});

const BURST_SETTINGS = { enabled: true, minRate: 0.2, maxMessages: 3 };

test('burst explains the split marker with the configured maximum', () => {
  assert.equal(
    sections.burst({ burstRate: 0.5, burst: BURST_SETTINGS }),
    'This user often sends several short messages in a row instead of one longer message. If that fits here, you may split your response into up to 3 separate messages by putting <split> on its own line between them. Only split where this user would.',
  );
  assert.match(sections.burst({ burstRate: 0.2, burst: { ...BURST_SETTINGS, maxMessages: 5 } }), /up to 5 separate/);
});

test('burst is absent below the minimum rate, when disabled, or without settings', () => {
  assert.equal(sections.burst({ burstRate: 0.19, burst: BURST_SETTINGS }), null);
  assert.equal(sections.burst({ burstRate: 0.9, burst: { ...BURST_SETTINGS, enabled: false } }), null);
  assert.equal(sections.burst({}), null);
});

test('topicExamples lists the similar bucket and is omitted when it is empty', () => {
  assert.equal(
    sections.topicExamples({ buckets: { similar: ['a', 'b'] } }),
    'Here are messages this user has sent about similar things:\n["a","b"]',
  );
  assert.equal(sections.topicExamples({ buckets: { similar: [] } }), null);
});

const CONVERSATION = {
  participants: ['alice', 'bob'], topic: 'Weekend plans', premise: 'A hike is floated.', remaining: 3, isLast: false,
};
const LEAD = 'You are taking part in a conversation in the channel between alice, bob. It is about: Weekend plans. A hike is floated. Only these people take part; do not address anyone else.';

test('conversationBrief for the opener names the people and the topic and asks for an opening message', () => {
  assert.equal(
    sections.conversationBrief({ conversation: CONVERSATION, isOpener: true }),
    `${LEAD} You are starting it. Write the message that opens the conversation. Do not greet the channel.`,
  );
});

test('conversationBrief for a later turn says how many messages follow', () => {
  assert.equal(
    sections.conversationBrief({ conversation: CONVERSATION, isOpener: false }),
    `${LEAD} Write your next message. React to what was just said, stay with the topic unless the conversation has naturally moved on, and do not end every message with a question. 3 more messages follow yours.`,
  );
});

test('conversationBrief for the last turn says nobody replies instead of counting', () => {
  const brief = sections.conversationBrief({ conversation: { ...CONVERSATION, remaining: 0, isLast: true }, isOpener: false });
  assert.ok(brief.endsWith('Nobody replies after this message, so do not ask the others a question.'));
  assert.ok(!brief.includes('more messages follow'));
});
