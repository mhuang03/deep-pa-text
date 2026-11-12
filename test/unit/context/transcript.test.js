import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, formatTranscript } from '../../../src/context/transcript.js';

const T = Date.UTC(2026, 10, 12, 18, 0);
const msg = (id, username, content, extra = {}) => ({
  id,
  author: { username, bot: extra.bot ?? false },
  content,
  createdTimestamp: extra.timestamp ?? T,
  reference: extra.reference ? { messageId: extra.reference } : null,
});

const options = (overrides = {}) => ({
  resolveBot: () => null,
  transform: (text) => text,
  maxEntryChars: 300,
  notBefore: 0,
  ...overrides,
});
const build = (messages, overrides) => buildTranscript(messages, options(overrides));

test('maps human messages to entries in order', () => {
  const result = build([msg('1', 'alice', 'hi', { timestamp: 5 }), msg('2', 'bob', 'yo', { timestamp: 6 })]);
  assert.deepEqual(result, [
    { id: '1', speaker: 'alice', content: 'hi', timestamp: 5, replyTo: null },
    { id: '2', speaker: 'bob', content: 'yo', timestamp: 6, replyTo: null },
  ]);
});

test('a resolved bot message uses the persona and the transformed stored content', () => {
  const resolveBot = (m) => (m.id === 'b' ? { persona: 'carol', content: 'ok <gif! cat>' } : null);
  const transform = (text) => text.toUpperCase();
  const result = build([msg('b', 'deep-pa-text', 'ignored', { bot: true })], { resolveBot, transform });
  assert.deepEqual(result.map((e) => [e.speaker, e.content]), [['carol', 'OK <GIF! CAT>']]);
});

test('unresolved bot messages are skipped', () => {
  assert.deepEqual(build([msg('1', 'robot', 'beep', { bot: true })]), []);
});

test('newlines become single spaces and content is trimmed', () => {
  const [entry] = build([msg('1', 'alice', '  a\nb\r\nc  ')]);
  assert.equal(entry.content, 'a b c');
});

test('empty content after transform or trimming is skipped', () => {
  const transform = (text) => (text === 'mention' ? '' : text);
  assert.deepEqual(build([msg('1', 'alice', 'mention'), msg('2', 'alice', '  \n ')], { transform }), []);
});

test('content over maxEntryChars is cut and gets an ellipsis; exact length is kept', () => {
  const [cut] = build([msg('1', 'alice', 'x'.repeat(400))]);
  assert.equal(cut.content, `${'x'.repeat(300)}…`);
  const [exact] = build([msg('2', 'alice', 'y'.repeat(300))]);
  assert.equal(exact.content, 'y'.repeat(300));
});

test('messages before notBefore are skipped; the boundary is kept', () => {
  const result = build([msg('1', 'a', 'old', { timestamp: 9 }), msg('2', 'a', 'edge', { timestamp: 10 })], { notBefore: 10 });
  assert.deepEqual(result.map((e) => e.id), ['2']);
});

test('replyTo names the speaker of an earlier entry in the result', () => {
  const result = build([msg('1', 'alice', 'one'), msg('2', 'carol', 'two', { reference: '1' })]);
  assert.equal(result[1].replyTo, 'alice');
});

test('replyTo is null for references outside the transcript', () => {
  const result = build([msg('2', 'carol', 'two', { reference: 'gone' })]);
  assert.equal(result[0].replyTo, null);
});

test('replyTo is null when the referenced entry was skipped', () => {
  const result = build([msg('1', 'alice', ''), msg('2', 'carol', 'two', { reference: '1' })]);
  assert.equal(result[0].replyTo, null);
});

test('formats lines with 24-hour time in the zone and a reply suffix', () => {
  const entries = [
    { id: '1', speaker: 'alice', content: 'anyone around', timestamp: T, replyTo: null },
    { id: '2', speaker: 'carol', content: 'yeah', timestamp: T + 60000, replyTo: 'alice' },
  ];
  assert.equal(
    formatTranscript(entries, { timeZone: 'America/Chicago' }),
    '[12:00] alice: anyone around\n[12:01] carol (replying to alice): yeah',
  );
});

test('midnight formats as 00:05, never 24:05', () => {
  const midnight = Date.UTC(2026, 10, 12, 6, 5);
  const line = formatTranscript(
    [{ id: '1', speaker: 'a', content: 'x', timestamp: midnight, replyTo: null }],
    { timeZone: 'America/Chicago' },
  );
  assert.equal(line, '[00:05] a: x');
});

test('an empty transcript formats as an empty string', () => {
  assert.equal(formatTranscript([], { timeZone: 'UTC' }), '');
});

test('an entry is cut by code points so an emoji at the boundary is kept whole or dropped whole', () => {
  const content = `${'a'.repeat(299)}\u{1F600}${'b'.repeat(5)}`;
  const [kept] = build([msg('1', 'alice', content)]);
  assert.equal(kept.content, `${'a'.repeat(299)}\u{1F600}…`);
  const [cut] = build([msg('2', 'alice', content)], { maxEntryChars: 299 });
  assert.equal(cut.content, `${'a'.repeat(299)}…`);
  assert.doesNotMatch(cut.content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
